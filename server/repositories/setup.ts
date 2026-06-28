/**
 * Setup / first-run wizard repository.
 *
 * Convex port: this file is now a thin adapter over `convex/setup.ts` (see
 * docs/CONVEX-MIGRATION.md §2). The bodies read/write through the shared
 * `getConvex()` handle.
 *
 * The in-process `getSetupStatusCached` memo stays here on purpose: it
 * short-circuits the live status read on the hot unmatched-GET path.
 * `resetSetupStatusCacheForTests` is unchanged.
 *
 * @see convex/setup.ts                 — the Convex query/mutation functions
 * @see server/handlers/cms/setup.ts    — the bootstrap-install handler
 */

import { api, getConvex } from '../convex/client'

interface SetupStatus {
  hasSite: boolean
  hasAdmin: boolean
  hasOwner: boolean
  needsSetup: boolean
}

export async function getSetupStatus(): Promise<SetupStatus> {
  return getConvex().query(api.setup.getStatus, {})
}

/**
 * Sticky setup-status memo for the server process.
 *
 * `needsSetup` only ever transitions true → false: setup creates the site and
 * the first owner, and the app refuses to deactivate or delete the last
 * active owner. Once a status with `needsSetup === false` has been observed
 * it is final for the process lifetime.
 */
let settledStatus: SetupStatus | null = null

/**
 * Like {@link getSetupStatus}, but skips the live status read once setup is
 * known to be complete. The router consults setup status on every unmatched
 * GET (bot probes hit that path forever on a long-lived install), so the hot
 * path must not hit the backend. While setup is still pending the status is
 * re-queried live on every call, so an in-progress setup is observed
 * immediately.
 */
export async function getSetupStatusCached(): Promise<SetupStatus> {
  if (settledStatus) return settledStatus
  const status = await getSetupStatus()
  if (!status.needsSetup) settledStatus = status
  return status
}

/** Drop all memoized statuses — for tests that rewind setup state out-of-band. */
export function resetSetupStatusCacheForTests(): void {
  settledStatus = null
}

export async function createSite(
  name: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await getConvex().mutation(api.setup.createSite, { name, settings })
}
