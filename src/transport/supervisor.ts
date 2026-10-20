// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
//
// The runtime holds exactly one AHP connection per SSH host. When the remote
// machine reboots (or the tunnel drops), every request on the dead client
// rejects with "client shut down" forever, because the original runtime only
// opened a connection once. This supervisor owns that lifecycle instead:
//
// - it opens the first connection eagerly (same as before);
// - it watches `client.stateChanges()` and starts a single-flight reconnect
//   as soon as the connection closes, so the next tool call transparently
//   joins the fresh attempt instead of failing;
// - `get()` additionally heals connections that were already closed or whose
//   initial attempt failed, one fresh attempt per call;
// - disposal stops supervision and shuts down whatever a late reconnect
//   eventually produces.

export type SupervisorConnectionStatus = 'idle' | 'connected' | 'closing' | 'closed'

export interface SupervisorClient {
  readonly connectionState: { readonly status: SupervisorConnectionStatus }
  stateChanges(): AsyncIterableIterator<{ readonly status: SupervisorConnectionStatus; readonly reason?: unknown }>
  shutdown(): Promise<void> | void
}

export interface SupervisorConnection {
  client: SupervisorClient
}

type Settled<T> =
  | { readonly status: 'pending' }
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly error: unknown }

async function inspect<T>(promise: Promise<T>): Promise<Settled<T>> {
  return Promise.race([
    promise.then(
      value => ({ status: 'fulfilled', value }) as const,
      error => ({ status: 'rejected', error }) as const,
    ),
    Promise.resolve().then(() => ({ status: 'pending' }) as const),
  ])
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ConnectionSupervisor<C extends SupervisorConnection> {
  private current: Promise<C>
  private reconnecting: Promise<C> | undefined
  private generation = 0

  constructor(
    private readonly open: () => Promise<C>,
    private readonly reset: () => void,
    private readonly isDisposed: () => boolean,
    private readonly label: string,
  ) {
    this.current = open()
    void this.supervise(this.current, this.generation)
    void this.current.catch(() => {})
  }

  /** The latest connection attempt, settled or not. */
  currentAttempt(): Promise<C> {
    return this.current
  }

  /** Resolve a healthy connection, reopening transparently after a loss. */
  async get(): Promise<C> {
    if (this.isDisposed()) throw new Error(`${this.label} service is disposing`)
    if (this.reconnecting !== undefined) return this.reconnecting
    const current = this.current
    const settled = await inspect(current)
    if (this.isDisposed()) throw new Error(`${this.label} service is disposing`)
    if (settled.status === 'fulfilled' && !this.isClosed(settled.value)) return settled.value
    if (settled.status === 'pending') return current
    this.startReconnect(settled.status === 'rejected' ? settled.error : undefined)
    if (this.isDisposed()) throw new Error(`${this.label} service is disposing`)
    return this.reconnecting ?? current
  }

  /** Invalidate supervision; the owner performs its own connection teardown. */
  stop(): void {
    this.generation += 1
  }

  private isClosed(connection: C): boolean {
    const status = connection.client.connectionState.status
    return status === 'closing' || status === 'closed'
  }

  /** Watch one connection; a close without our own shutdown triggers reconnect. */
  private async supervise(attempt: Promise<C>, generation: number): Promise<void> {
    let connection: C
    try {
      connection = await attempt
    } catch {
      return
    }
    if (generation !== this.generation || this.isDisposed()) return
    try {
      for await (const state of connection.client.stateChanges()) {
        if (state.status === 'closed') {
          if (generation !== this.generation || this.isDisposed()) return
          this.startReconnect(state.reason)
          return
        }
      }
    } catch (error: unknown) {
      // A transport tear-down may reject the state stream itself; that is a
      // loss all the same and must not surface as an unhandled rejection.
      if (generation !== this.generation || this.isDisposed()) return
      this.startReconnect(error)
      return
    }
    // The stream ended without a terminal state; treat it as a loss anyway.
    if (generation === this.generation && !this.isDisposed() && this.isClosed(connection)) {
      this.startReconnect()
    }
  }

  /** Single-flight reconnect; concurrent callers join the same attempt. */
  private startReconnect(cause?: unknown): void {
    if (this.isDisposed() || this.reconnecting !== undefined) return
    const generation = this.generation + 1
    this.generation = generation
    this.reset()
    const diagnostic = cause === undefined ? undefined : describeError(cause)
    const attempt = this.open().catch((error: unknown) => {
      const reason = diagnostic === undefined ? 'remote connection lost' : `remote connection lost (${diagnostic})`
      throw new Error(`${this.label}: ${reason}; reconnect failed: ${describeError(error)}`, { cause: error })
    })
    this.reconnecting = attempt
    void attempt.then(
      connection => {
        if (this.isDisposed() || generation !== this.generation) {
          void Promise.resolve(connection.client.shutdown()).catch(() => {})
          return
        }
        this.current = Promise.resolve(connection)
        this.reconnecting = undefined
        void this.supervise(this.current, generation)
      },
      () => {
        if (this.reconnecting === attempt) this.reconnecting = undefined
      },
    )
  }
}
