// A/B verification for dsh-ssh-workspace reconnect (ahian-lee, 2026-10-20).
// Uses the real SSH startup path against 4090-dilab. Phase 1 resolves+reads
// README.md through AHP. After the local sentinel file appears, the
// orchestrator kills the remote agent host (simulating the machine reboot
// that killed the old session). Phase 2 repeats the same calls and must
// succeed via a transparent reconnect.
import { existsSync, rmSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import RemoteSshRuntime from '../lib/index.js'
import RemoteSshFileSystem from '../lib/fs.js'

const [, , sentinel] = process.argv
if (!sentinel) throw new Error('usage: node ab-reconnect.mjs <sentinel-file>')
rmSync(sentinel, { force: true })
const ctx = new Context()
await ctx.plugin(RemoteSshRuntime, {
  sshTarget: '4090-dilab',
  remoteWorkspace: '/home/user/lyh/projects/mof-agent-edit',
  localWorkspace: 'C:/Users/23725/AppData/Local/Temp/dsh-ab-alias',
  remoteRuntimeRoot: '/tmp/dsh-ssh-workspace-ab',
})
await ctx.plugin(RemoteSshFileSystem, { diffBasisMaxBytes: 1024 * 1024, maxReadBytes: 1024 * 1024 })
const readme = await ctx.fs.resolve('README.md')
const text = await ctx.fs.readText(readme)
console.log(`PHASE1_OK bytes=${text.length}`)

const deadline = Date.now() + 180_000
while (!existsSync(sentinel)) {
  if (Date.now() > deadline) throw new Error('sentinel never appeared')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
}
rmSync(sentinel, { force: true })
console.log('SENTINEL_SEEN reconnecting…')

const readme2 = await ctx.fs.resolve('README.md')
const text2 = await ctx.fs.readText(readme2)
console.log(`PHASE2_OK bytes=${text2.length}`)
console.log(`FINAL_STATE=${(await ctx.remoteSsh.getConnection()).client.connectionState.status}`)
await (await ctx.remoteSsh.getConnection()).client.shutdown()
process.exit(0)
