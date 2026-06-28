/**
 * Server→Convex transport. Replaces the SQL `DbClient` for ported domains.
 *
 * One lazily-constructed `ConvexHttpClient` per server process (mirrors the
 * single SQL `DbClient`), pointed at the self-hosted backend
 * (`CONVEX_SELF_HOSTED_URL`, falling back to `CONVEX_URL`) and authenticated
 * with the admin/deploy key when present. The Bun server is a fully trusted
 * backend — every capability check already ran in the HTTP handler — so
 * identity travels in function args, never on this channel
 * (docs/CONVEX-MIGRATION.md §1.1).
 *
 * Repositories import `{ getConvex, api }` and call
 * `getConvex().query(api.<domain>.<fn>, args)` /
 * `getConvex().mutation(api.<domain>.<fn>, args)`.
 */

import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../convex/_generated/api'

// `setAdminAuth` is the real self-hosted admin-key auth method used by trusted
// backends (the Convex CLI uses it too). It exists at runtime but is marked
// `@internal` in convex's published types, so we re-declare it here to call it
// without an `as any` escape.
declare module 'convex/browser' {
  interface ConvexHttpClient {
    setAdminAuth(adminKey: string): void
  }
}

let client: ConvexHttpClient | undefined

/** The shared, lazily-initialized server-side Convex handle. */
export function getConvex(): ConvexHttpClient {
  if (client) return client
  const url = process.env.CONVEX_SELF_HOSTED_URL ?? process.env.CONVEX_URL
  if (!url) {
    throw new Error(
      '[convex] CONVEX_SELF_HOSTED_URL (or CONVEX_URL) must be set to reach the Convex backend',
    )
  }
  client = new ConvexHttpClient(url)
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY
  if (adminKey) client.setAdminAuth(adminKey)
  return client
}

export { api }
