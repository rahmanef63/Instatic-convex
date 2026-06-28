import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('self-host docker config', () => {
  it('documents the Convex backend connection in the env template', () => {
    const env = readFileSync('.env.example', 'utf8')
    // The server has no local datastore — it reaches Convex through these vars
    // (server/convex/client.ts). The template must document the URL var and the
    // non-database runtime paths.
    expect(env).toContain('CONVEX_SELF_HOSTED_URL=')
    expect(env).toContain('UPLOADS_DIR=')
  })

  it('defines a production Docker image that builds assets before runtime startup', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')

    expect(dockerfile).toContain('FROM oven/bun:1.3.11 AS build')
    expect(dockerfile).toContain('RUN bun run build')
    expect(dockerfile).toContain('FROM oven/bun:1.3.11 AS runtime')
    expect(dockerfile).toContain('ARG INSTATIC_VERSION=dev')
    expect(dockerfile).toContain('LABEL org.opencontainers.image.version="${INSTATIC_VERSION}"')
    expect(dockerfile).toContain('CMD ["bun", "run", "server/index.ts"]')
    expect(dockerfile).not.toContain('vite build && bun run server/index.ts')
  })

  it('keeps TypeScript path aliases available in the runtime image', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')

    expect(dockerfile).toContain('COPY --chown=bun:bun tsconfig*.json ./')
  })

  it('installs the runtime script bundler in production dependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(pkg.dependencies?.esbuild).toBeTruthy()
    expect(pkg.devDependencies?.esbuild).toBeUndefined()
  })

  it('allows PATCH in server CORS preflight for CMS media rename', () => {
    const serverIndex = readFileSync('server/index.ts', 'utf8')

    expect(serverIndex).toContain("'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'")
  })

  it('defines a production compose stack that points the app at the Convex backend', () => {
    const compose = readFileSync('compose.prod.yml', 'utf8')
    const buildOverride = readFileSync('compose.build.yml', 'utf8')

    expect(compose).toContain('ghcr.io/corebunch/instatic:latest')
    expect(compose).not.toContain('build:')
    expect(compose).toContain('restart: unless-stopped')
    // The app is a Convex client — it reaches its data layer over HTTP at the
    // self-hosted Convex backend (a separate compose). There is no bundled
    // database service in this file.
    expect(compose).toContain('CONVEX_SELF_HOSTED_URL')
    expect(compose).toContain('CONVEX_SELF_HOSTED_ADMIN_KEY')
    expect(compose).not.toContain('postgres')
    expect(compose).toContain('uploads:')
    expect(buildOverride).toContain('build:')
    expect(buildOverride).toContain('dockerfile: Dockerfile')
  })

  it('defines production environment variables required by the compose stack', () => {
    const env = readFileSync('.env.production.example', 'utf8')
    const compose = readFileSync('compose.prod.yml', 'utf8')

    expect(env).toContain('CONVEX_SELF_HOSTED_URL=')
    expect(env).toContain('CONVEX_SELF_HOSTED_ADMIN_KEY=')
    expect(env).toContain('INSTATIC_SECRET_KEY=')
    expect(env).toContain('TRUSTED_PROXY_CIDRS=')
    expect(compose).toContain('CONVEX_SELF_HOSTED_URL:')
    expect(compose).toContain('CONVEX_SELF_HOSTED_ADMIN_KEY:')
    expect(compose).toContain('INSTATIC_SECRET_KEY:')
    expect(compose).toContain('TRUSTED_PROXY_CIDRS:')
  })
})
