/**
 * Setup / first-run wizard repository.
 *
 * Convex port: this file is now a thin adapter over `convex/setup.ts` (see
 * docs/CONVEX-MIGRATION.md §2). The exported signatures are frozen — the
 * leading SQL `DbClient` handle is retained (named `_db`, intentionally unused)
 * so handlers keep calling these unchanged while the rest of the runtime is
 * still on the SQL path; the bodies read/write through the shared `getConvex()`
 * handle instead.
 *
 * The in-process `getSetupStatusCached` memo stays here on purpose: it is keyed
 * by the server-process client handle and short-circuits the live status read
 * on the hot unmatched-GET path. `resetSetupStatusCacheForTests` is unchanged.
 *
 * @see convex/setup.ts                 — the Convex query/mutation functions
 * @see server/handlers/cms/setup.ts    — the bootstrap-install handler
 */

import type { DbClient } from '../db/client'
import { api, getConvex } from '../convex/client'

interface SetupStatus {
  hasSite: boolean
  hasAdmin: boolean
  hasOwner: boolean
  needsSetup: boolean
}

export async function getSetupStatus(_db: DbClient): Promise<SetupStatus> {
  return getConvex().query(api.setup.getStatus, {})
}

/**
 * Sticky setup-status memo, keyed by `DbClient` instance.
 *
 * `needsSetup` only ever transitions true → false: setup creates the site and
 * the first owner, and the app refuses to deactivate or delete the last
 * active owner. Once a status with `needsSetup === false` has been observed
 * it is final for the process lifetime.
 *
 * Keyed by client (WeakMap) rather than a bare module global so tests that
 * spin up a fresh database per test stay isolated without manual resets.
 */
let settledStatusByDb = new WeakMap<DbClient, SetupStatus>()

/**
 * Like {@link getSetupStatus}, but skips the live status read once setup is
 * known to be complete. The router consults setup status on every unmatched
 * GET (bot probes hit that path forever on a long-lived install), so the hot
 * path must not hit the backend. While setup is still pending the status is
 * re-queried live on every call, so an in-progress setup is observed
 * immediately.
 */
export async function getSetupStatusCached(db: DbClient): Promise<SetupStatus> {
  const settled = settledStatusByDb.get(db)
  if (settled) return settled
  const status = await getSetupStatus(db)
  if (!status.needsSetup) settledStatusByDb.set(db, status)
  return status
}

/** Drop all memoized statuses — for tests that rewind setup state out-of-band. */
export function resetSetupStatusCacheForTests(): void {
  settledStatusByDb = new WeakMap()
}

export async function createSite(
  _db: DbClient,
  name: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await getConvex().mutation(api.setup.createSite, { name, settings })
}
