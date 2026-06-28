/**
 * Login-attempt audit trail.
 *
 * Every authentication attempt — successful or not, against a known account or
 * not — produces one row here. Two callers:
 *
 *   1. The login handler logs the result of each attempt for forensic review
 *      and to give operators a "who tried to log in as foo@bar.com" feed.
 *   2. The per-account lockout policy in `server/auth/lockout.ts` is driven by
 *      `users.failed_login_count` (a fast running counter), but operators can
 *      still inspect the underlying attempt history via this table.
 *
 * The table is append-only by convention; cleanup (retention) is left to a
 * future change set when audit volume warrants it. Rows are tiny.
 *
 * Convex port: this file is now a thin adapter over `convex/loginAttempts.ts`
 * (see docs/CONVEX-MIGRATION.md §2). The exported signatures are frozen — the
 * leading SQL `DbClient` handle is retained (named `_db`, intentionally unused)
 * so handlers keep calling these unchanged while the rest of the runtime is
 * still on the SQL path; the bodies read/write through the shared `getConvex()`
 * handle instead. It is dropped wholesale when `server/db/*` is retired (§7).
 * All row-shaping and ordering now live in the Convex functions.
 *
 * @see convex/loginAttempts.ts        — the Convex query/mutation functions
 * @see server/auth/lockout.ts         — policy that consumes this
 */

import type { DbClient } from '../db/client'
import { api, getConvex } from '../convex/client'

export type LoginAttemptResult =
  | 'success'
  | 'bad_password'
  | 'no_user'
  | 'account_disabled'
  | 'locked'
  | 'rate_limited'
  | 'mfa_failed'

interface LoginAttempt {
  id: string
  attemptedAt: string
  emailNorm: string | null
  ipAddress: string | null
  userAgent: string | null
  userId: string | null
  result: LoginAttemptResult
}

export async function recordLoginAttempt(
  _db: DbClient,
  input: {
    emailNorm: string | null
    ipAddress: string | null
    userAgent: string | null
    userId: string | null
    result: LoginAttemptResult
  },
): Promise<void> {
  await getConvex().mutation(api.loginAttempts.record, {
    emailNorm: input.emailNorm,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    userId: input.userId,
    result: input.result,
  })
}

export async function listLoginAttemptsForUser(
  _db: DbClient,
  userId: string,
  limit = 50,
): Promise<LoginAttempt[]> {
  return getConvex().query(api.loginAttempts.listForUser, { userId, limit })
}

/**
 * Per-account login activity feed. Combines:
 *
 *   - rows where `user_id = $userId` (post-lookup attempts — the user
 *     existed and the system identified the account)
 *   - rows where `email_norm = $emailNorm` and `user_id IS NULL` (pre-lookup
 *     attempts that mention this email but haven't been associated to a
 *     user — e.g. failed logins against a freshly suspended account, or
 *     attempts that hit the rate-limit / locked guards before the user-row
 *     lookup completed)
 *
 * The Activity tab on the Account page renders this feed so the user sees
 * "someone tried my email from a new IP" alongside their own successful
 * sessions.
 */
export async function listLoginActivityForUser(
  _db: DbClient,
  userId: string,
  emailNorm: string,
  limit = 50,
): Promise<LoginAttempt[]> {
  return getConvex().query(api.loginAttempts.listActivityForUser, {
    userId,
    emailNorm,
    limit,
  })
}

export async function listLoginAttemptsForIp(
  _db: DbClient,
  ipAddress: string,
  limit = 50,
): Promise<LoginAttempt[]> {
  return getConvex().query(api.loginAttempts.listForIp, { ipAddress, limit })
}
