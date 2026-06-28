/**
 * Session repository — read + revoke operations on the `sessions` table.
 *
 * `server/auth/sessions.ts` keeps the *write-side* (createSession,
 * findUserBySessionHash) and the sliding-window expiry math. This file owns
 * the user-facing operations: listing devices and revoking them. They live
 * here because they're CRUD over the row shape, not auth-decision logic.
 *
 * Cross-user safety: every mutation joins on `user_id` so a session id
 * belonging to another user cannot be revoked by passing its hash to one of
 * these functions. That's a defense-in-depth rule on top of the handler
 * pulling the user from the cookie before calling these.
 *
 * Convex port: this file is now a thin adapter over `convex/sessions.ts`
 * (see docs/CONVEX-MIGRATION.md §2). The bodies read/write through the shared
 * `getConvex()` handle. All row-shaping, ordering, and the cross-user guard now
 * live in the Convex functions.
 *
 * @see convex/sessions.ts — the Convex query/mutation functions
 */
import { api, getConvex } from '../convex/client'

interface SessionListItem {
  id: string                       // sha256 hash of the cookie token (same as session.id_hash)
  deviceLabel: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  isCurrent: boolean               // true when id matches the request's session hash
  mfaPassedAt: string | null
  stepUpExpiresAt: string | null
}

/**
 * List all live (non-revoked, non-expired) sessions for a user, newest
 * activity first. The current session — identified by `currentSessionHash` —
 * is flagged via `isCurrent: true` so the UI can pin it to the top of the
 * device list and disable the "Sign out" action on it.
 */
export async function listSessionsForUser(
  userId: string,
  currentSessionHash: string | null,
  now: Date = new Date(),
): Promise<SessionListItem[]> {
  return getConvex().query(api.sessions.listForUser, {
    userId,
    currentSessionHash,
    nowIso: now.toISOString(),
  })
}

/**
 * Revoke a single session by its hash, ONLY if it belongs to `userId`. The
 * `user_id = $userId` predicate is the cross-user guard — passing another
 * user's session hash returns 0 affected rows, never modifies anyone else's
 * row.
 *
 * Returns true when a row was actually updated, false otherwise (already
 * revoked, expired, belongs to another user, or doesn't exist).
 */
export async function revokeSessionByHashForUser(
  sessionHash: string,
  userId: string,
): Promise<boolean> {
  return getConvex().mutation(api.sessions.revokeByHashForUser, {
    sessionHash,
    userId,
  })
}

/**
 * Revoke every live session for `userId` EXCEPT the request's current
 * session. The current session is preserved so the user issuing the
 * "Sign out everywhere else" action doesn't immediately log themselves out.
 *
 * If `keepSessionHash` is null (caller couldn't identify the current
 * session — shouldn't happen in the normal flow), the operation revokes
 * EVERY session, which is the safe-but-harsh fallback.
 *
 * Returns the number of sessions revoked.
 */
export async function revokeAllOtherSessions(
  userId: string,
  keepSessionHash: string | null,
): Promise<number> {
  return getConvex().mutation(api.sessions.revokeAllOther, {
    userId,
    keepSessionHash,
  })
}
