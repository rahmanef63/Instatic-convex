/**
 * Session device-management — Convex functions.
 *
 * The Convex half of the user-facing session operations: listing live devices
 * and revoking them. The thin repository adapter
 * (`server/repositories/sessions.ts`) marshals args into these and returns the
 * results unchanged — all real logic (the live-session predicate, the
 * cross-user `user_id` guard, the `last_seen_at desc` ordering, the
 * `isCurrent` flag) lives here.
 *
 * Conventions this slice follows (docs/CONVEX-MIGRATION.md §2, §4):
 * - Sessions are keyed by the app-generated `id_hash` (the SHA-256 of the
 *   cookie token, minted in the Bun server — crypto stays server-side, §5).
 *   We look rows up by the `by_id_hash` index, never by Convex `_id`.
 * - Timestamps that were SQL `current_timestamp` defaults (`revoked_at`) are
 *   generated inside the mutation as ISO strings.
 * - Every function declares both `args` and `returns` validators.
 * - Reads return the camelCase `SessionListItem` shape the repository already
 *   exposes, so the repository stays a pure pass-through.
 *
 * Scope note: the session *write-side* (`createSession`,
 * `findUserBySessionHash`, `rotateSessionToken`, the sliding-window expiry math)
 * lives in `server/auth/sessions.ts`, which is ported alongside the users-domain
 * `AuthUser` hydration it depends on — not in this device-management slice.
 *
 * @see server/repositories/sessions.ts — the thin adapter that calls these
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import type { Doc } from './_generated/dataModel'

/** The camelCase shape every read returns — matches the repository's `SessionListItem`. */
const sessionListItemValidator = v.object({
  id: v.string(),
  deviceLabel: v.string(),
  ipAddress: v.union(v.null(), v.string()),
  userAgent: v.union(v.null(), v.string()),
  createdAt: v.string(),
  lastSeenAt: v.string(),
  expiresAt: v.string(),
  isCurrent: v.boolean(),
  mfaPassedAt: v.union(v.null(), v.string()),
  stepUpExpiresAt: v.union(v.null(), v.string()),
})

function toListItem(row: Doc<'sessions'>, currentSessionHash: string | null) {
  return {
    id: row.id_hash,
    deviceLabel: row.device_label || '',
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    isCurrent: currentSessionHash !== null && row.id_hash === currentSessionHash,
    mfaPassedAt: row.mfa_passed_at,
    stepUpExpiresAt: row.step_up_expires_at,
  }
}

/**
 * List all live (non-revoked, non-expired) sessions for a user, newest activity
 * first. The current session — identified by `currentSessionHash` — is flagged
 * via `isCurrent: true` so the UI can pin it and disable its "Sign out" action.
 *
 * SQL: `where user_id = ? and revoked_at is null and expires_at > now order by
 * last_seen_at desc`. The `by_user_last_seen` index gives the ordering; the
 * `revoked_at is null` / `expires_at > now` predicates are applied in-handler
 * (ISO-8601 strings compare lexically, so `>` on the string is the same as on
 * the timestamp).
 */
export const listForUser = query({
  args: {
    userId: v.string(),
    currentSessionHash: v.union(v.null(), v.string()),
    nowIso: v.string(),
  },
  returns: v.array(sessionListItemValidator),
  handler: async (ctx, { userId, currentSessionHash, nowIso }) => {
    const rows = await ctx.db
      .query('sessions')
      .withIndex('by_user_last_seen', (q) => q.eq('user_id', userId))
      .order('desc')
      .collect()
    return rows
      .filter((row) => row.revoked_at === null && row.expires_at > nowIso)
      .map((row) => toListItem(row, currentSessionHash))
  },
})

/**
 * Revoke a single session by its hash, ONLY if it belongs to `userId`. The
 * `user_id === userId` check is the cross-user guard — passing another user's
 * session hash is a no-op, never modifies anyone else's row.
 *
 * Returns true when a row was actually revoked, false otherwise (already
 * revoked, belongs to another user, or doesn't exist).
 */
export const revokeByHashForUser = mutation({
  args: { sessionHash: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sessionHash, userId }) => {
    const row = await ctx.db
      .query('sessions')
      .withIndex('by_id_hash', (q) => q.eq('id_hash', sessionHash))
      .unique()
    if (!row || row.user_id !== userId || row.revoked_at !== null) return false
    await ctx.db.patch(row._id, { revoked_at: new Date().toISOString() })
    return true
  },
})

/**
 * Revoke every live session for `userId` EXCEPT the request's current session
 * (`keepSessionHash`). When `keepSessionHash` is null the caller couldn't
 * identify the current session, so EVERY live session is revoked — the
 * safe-but-harsh fallback.
 *
 * One atomic mutation replaces the bulk SQL UPDATE: the SQL `WHERE` collapsed
 * to a per-user index scan + in-handler filter, then a patch per matched row.
 * Returns the number of sessions revoked.
 */
export const revokeAllOther = mutation({
  args: { userId: v.string(), keepSessionHash: v.union(v.null(), v.string()) },
  returns: v.number(),
  handler: async (ctx, { userId, keepSessionHash }) => {
    const rows = await ctx.db
      .query('sessions')
      .withIndex('by_user_last_seen', (q) => q.eq('user_id', userId))
      .collect()
    const revokedAt = new Date().toISOString()
    let revoked = 0
    for (const row of rows) {
      if (row.revoked_at !== null) continue
      if (keepSessionHash !== null && row.id_hash === keepSessionHash) continue
      await ctx.db.patch(row._id, { revoked_at: revokedAt })
      revoked += 1
    }
    return revoked
  },
})
