// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { describe, expect, it } from 'vitest'
import { ConnectionSupervisor, type SupervisorClient, type SupervisorConnection } from '../src/transport/supervisor.ts'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Flush every pending microtask, including supervisor state notifications. */
const flush = (): Promise<void> => new Promise(resolvePromise => setTimeout(resolvePromise, 0))

class FakeClient implements SupervisorClient {
  private readonly listeners: Array<(state: { status: string }) => void> = []
  status: 'idle' | 'connected' | 'closing' | 'closed' = 'idle'
  shutdowns = 0

  get connectionState(): { readonly status: 'idle' | 'connected' | 'closing' | 'closed' } {
    return { status: this.status }
  }

  setState(status: 'idle' | 'connected' | 'closing' | 'closed'): void {
    this.status = status
    for (const listener of [...this.listeners]) listener({ status })
  }

  async *stateChanges(): AsyncIterableIterator<{ readonly status: string }> {
    let notify = deferred<void>()
    const push = (): void => { notify.resolve(); notify = deferred<void>() }
    this.listeners.push(push)
    try {
      while (this.status !== 'closed') {
        await notify.promise
        yield { status: this.status }
      }
      yield { status: 'closed' }
    } finally {
      const index = this.listeners.indexOf(push)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1
    this.setState('closed')
  }

  markTransportLoss(): void {
    this.setState('closed')
  }
}

class FakeConnection implements SupervisorConnection {
  constructor(readonly client: FakeClient) {}
}

interface Harness {
  supervisor: ConnectionSupervisor<FakeConnection>
  opens: Array<Deferred<FakeConnection>>
  readonly resets: number
  settleNext(): FakeClient
}

function createSupervisor(disposed = (): boolean => false): Harness {
  const opens: Array<Deferred<FakeConnection>> = []
  let resets = 0
  const supervisor = new ConnectionSupervisor<FakeConnection>(
    () => {
      const attempt = deferred<FakeConnection>()
      opens.push(attempt)
      return attempt.promise
    },
    () => { resets += 1 },
    disposed,
    'test',
  )
  return {
    supervisor,
    opens,
    get resets() { return resets },
    settleNext(): FakeClient {
      const client = new FakeClient()
      opens.at(-1)!.resolve(new FakeConnection(client))
      return client
    },
  }
}

describe('ConnectionSupervisor', () => {
  it('returns the healthy first connection without side effects', async () => {
    const harness = createSupervisor()
    harness.settleNext().setState('connected')
    const connection = await harness.supervisor.currentAttempt()
    expect(await harness.supervisor.get()).toBe(connection)
    expect(harness.opens).toHaveLength(1)
    expect(harness.resets).toBe(0)
  })

  it('joins the still-pending first attempt instead of opening a second one', async () => {
    const harness = createSupervisor()
    const joining = harness.supervisor.get()
    expect(harness.opens).toHaveLength(1)
    const client = harness.settleNext()
    client.setState('connected')
    expect(await joining).toBe(await harness.supervisor.currentAttempt())
  })

  it('reconnects once after the connection closes and joins the new attempt', async () => {
    const harness = createSupervisor()
    harness.settleNext().setState('connected')
    const first = await harness.supervisor.get()
    expect(harness.opens).toHaveLength(1)

    first.client.markTransportLoss()
    await flush()
    const joining = harness.supervisor.get()
    const again = harness.supervisor.get()
    expect(harness.opens).toHaveLength(2)
    harness.settleNext().setState('connected')
    expect(await joining).toBe(await again)
    expect(await joining).toBe(await harness.supervisor.currentAttempt())
    expect(harness.resets).toBe(1)
    expect(first.client.shutdowns).toBe(0)
  })

  it('recovers when the very first attempt rejects', async () => {
    const harness = createSupervisor()
    harness.opens[0]!.reject(new Error('ssh: connect refused'))
    await harness.supervisor.currentAttempt().catch(() => {})
    await flush()
    const healing = harness.supervisor.get()
    await flush()
    expect(harness.opens).toHaveLength(2)
    harness.settleNext().setState('connected')
    expect(await healing).toBe(await harness.supervisor.currentAttempt())
  })

  it('propagates the original error of the in-flight first attempt', async () => {
    const harness = createSupervisor()
    const pending = harness.supervisor.get()
    harness.opens[0]!.reject(new Error('ssh: connect refused'))
    await expect(pending).rejects.toThrow('ssh: connect refused')
  })

  it('wraps a failed reconnect with a diagnostic and allows a later retry', async () => {
    const harness = createSupervisor()
    harness.settleNext().setState('connected')
    const first = await harness.supervisor.get()

    first.client.markTransportLoss()
    await flush()
    const joining = harness.supervisor.get()
    harness.opens.at(-1)!.reject(new Error('host unreachable'))
    await expect(joining).rejects.toThrow('reconnect failed')
    expect(harness.resets).toBe(1)

    const retry = harness.supervisor.get()
    await flush()
    expect(harness.opens).toHaveLength(3)
    harness.settleNext().setState('connected')
    expect(await retry).toBe(await harness.supervisor.currentAttempt())
  })

  it('shuts down a late connection that resolves after stop()', async () => {
    let disposed = false
    const harness = createSupervisor(() => disposed)
    harness.settleNext().setState('connected')
    const first = await harness.supervisor.get()

    first.client.markTransportLoss()
    await flush()
    expect(harness.opens).toHaveLength(2)
    harness.supervisor.stop()
    disposed = true
    const client = harness.settleNext()
    await flush()
    expect(client.shutdowns).toBe(1)
  })

  it('ignores state changes from a superseded generation', async () => {
    let disposed = false
    const harness = createSupervisor(() => disposed)
    harness.settleNext().setState('connected')
    const first = await harness.supervisor.get()

    first.client.markTransportLoss()
    await flush()
    expect(harness.opens).toHaveLength(2)
    harness.settleNext().setState('connected')
    harness.supervisor.stop()
    // The old client closing again must not start another reconnect.
    disposed = true
    first.client.markTransportLoss()
    await flush()
    expect(harness.opens).toHaveLength(2)
  })
})
