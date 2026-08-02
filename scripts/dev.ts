/**
 * One-command dev server.
 *
 * `bun run dev` is the only thing a developer should need. It spawns the cms
 * (`bun --watch server/index.ts`) and vite (`vite --host 127.0.0.1`) as
 * children, forwarding their output and signals so Ctrl+C cleanly kills both.
 *
 * The server has no local datastore — it talks to a self-hosted Convex backend
 * over HTTP. Set `CONVEX_SELF_HOSTED_URL` (or `CONVEX_URL`) and a Convex admin
 * key in `.env.local` (auto-loaded by Bun) before running. Stand up or point at
 * a backend per docs/DEPLOY-CONVEX.md.
 *
 * Before spawning, the script:
 *   - Fails fast with a clear message if no Convex backend URL is configured
 *     (mirrors the server's own boot guard in server/index.ts).
 *   - Pre-checks ports 3001 (cms) and 5173 (vite) and prints an actionable
 *     message if either is held by something we don't own.
 */

import { ensurePortFree } from './lib/freePort'

const CMS_PORT = Number(process.env.PORT ?? '3001')
const VITE_PORT = Number(process.env.VITE_PORT ?? '5173')

function log(msg: string): void {
  console.error(`[dev] ${msg}`)
}

function fail(msg: string): never {
  log(msg)
  process.exit(1)
}

// --- main -----------------------------------------------------------------

if (!process.env.CONVEX_SELF_HOSTED_URL && !process.env.CONVEX_URL) {
  fail(
    'CONVEX_SELF_HOSTED_URL (or CONVEX_URL) is not set — the server needs a Convex backend.\n' +
      '      Add it (and a Convex admin key) to .env.local. See docs/DEPLOY-CONVEX.md.',
  )
}

await ensurePortFree(CMS_PORT, 'cms', log)
await ensurePortFree(VITE_PORT, 'vite', log)

log('')
log(`Open the editor at:  http://localhost:${VITE_PORT}`)
log(`CMS API runs on:     http://localhost:${CMS_PORT} (you usually don't open this directly)`)
log('')

// --- spawn cms + vite -----------------------------------------------------

interface DevProcess {
  name: string
  command: string
  env?: Record<string, string>
}

const processes: DevProcess[] = [
  {
    name: 'cms',
    command: 'bun --watch server/index.ts',
    env: {
      PORT: String(CMS_PORT),
      STATIC_DIR: process.env.STATIC_DIR ?? './dist',
      UPLOADS_DIR: process.env.UPLOADS_DIR ?? './uploads',
    },
  },
  {
    name: 'vite',
    command: `vite --host 127.0.0.1 --port ${VITE_PORT} --strictPort`,
  },
]

const children: Bun.Subprocess[] = []
let shuttingDown = false

function stopChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal)
  }
}

for (const cfg of processes) {
  const child = Bun.spawn(cfg.command.split(' '), {
    env: { ...process.env, ...cfg.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  children.push(child)
  void child.exited.then((code) => {
    if (shuttingDown) return
    shuttingDown = true
    stopChildren()
    process.exit(code)
  })
}

process.on('SIGINT', () => {
  shuttingDown = true
  stopChildren('SIGINT')
})

process.on('SIGTERM', () => {
  shuttingDown = true
  stopChildren('SIGTERM')
})
