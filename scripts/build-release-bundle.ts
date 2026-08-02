import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const OUT_DIR = join(ROOT, '.tmp', 'release')

const version = Bun.argv[2] ?? process.env.INSTATIC_VERSION
if (!version) {
  throw new Error('Usage: bun run release:bundle -- <semver>')
}

const bundleName = `instatic-${version}`
const stagingDir = join(OUT_DIR, bundleName)
const archivePath = join(OUT_DIR, `${bundleName}-release-bundle.tar.gz`)

const bundleFiles = [
  'compose.prod.yml',
  'compose.tls.yml',
  'convex/compose.selfhosted.yml',
  '.env.production.example',
  'docs/DEPLOY-CONVEX.md',
  'docs/deployment/README.md',
  'docs/deployment/vps.md',
  'docs/deployment/docker-image.md',
  'docs/deployment/tls-caddy.md',
  'docs/deployment/backup-restore.md',
]

async function copyIntoBundle(path: string): Promise<void> {
  const source = join(ROOT, path)
  if (!existsSync(source)) {
    throw new Error(`Release bundle source is missing: ${path}`)
  }
  const destination = join(stagingDir, path)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

await rm(stagingDir, { recursive: true, force: true })
await rm(archivePath, { force: true })
await mkdir(stagingDir, { recursive: true })

for (const file of bundleFiles) {
  await copyIntoBundle(file)
}

await writeFile(
  join(stagingDir, 'INSTALL.md'),
  `# Instatic ${version} Install Bundle

Production Compose files and deployment docs for Instatic ${version}.

Instatic's data layer is a **self-hosted Convex backend** — there is no managed
Postgres and no SQLite file. You deploy two halves together: the Bun app
(\`compose.prod.yml\`) and a self-hosted Convex backend
(\`convex/compose.selfhosted.yml\`) whose entire database lives in the persistent
\`instatic_convex_data\` volume.

## Install

\`\`\`sh
# 1. Stand up the self-hosted Convex backend (persists in instatic_convex_data).
docker compose -f convex/compose.selfhosted.yml up -d

# 2. Configure the app env.
cp .env.production.example .env
# Edit .env: set CONVEX_SELF_HOSTED_URL (the backend URL),
# CONVEX_SELF_HOSTED_ADMIN_KEY (a generated Convex admin key), and
# INSTATIC_SECRET_KEY (bun run scripts/generate-secret-key.ts).

# 3. Push convex/schema.ts + functions to the backend, then bring up the app.
INSTATIC_IMAGE=ghcr.io/corebunch/instatic:${version} docker compose -f compose.prod.yml up -d
\`\`\`

Read \`docs/DEPLOY-CONVEX.md\` for the full reference — standing up the Convex
backend, generating the admin key, pushing the schema, and the
\`VITE_CONVEX_URL\` browser build arg — then \`docs/deployment/vps.md\` and
\`docs/deployment/backup-restore.md\` before running a public site.
`,
  'utf-8',
)

const tar = spawnSync('tar', ['-czf', archivePath, '-C', OUT_DIR, bundleName], {
  stdio: 'inherit',
})

if (tar.status !== 0) {
  throw new Error(`tar failed with exit code ${tar.status ?? 'unknown'}`)
}

console.log(archivePath)
