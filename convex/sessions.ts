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
import { mutation, query, type QueryCtx } from './_generated/server'
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

// ---------------------------------------------------------------------------
// Session lifecycle — the write-side of `server/auth/sessions.ts`.
//
// These back session creation, the live-session + user hydration lookup, the
// sliding-window `last_seen_at` touch, single-hash revoke, the step-up read,
// the atomic token-rotation transaction, and the MFA-pass stamp. Token hashing
// stays Bun-side (docs/CONVEX-MIGRATION.md §5): only the SHA-256 `id_hash` and
// the derived ISO timestamps ever cross this channel.
//
// The session lookup hand-joins `users JOIN roles LEFT JOIN media_assets`
// exactly like `convex/users.ts:hydrateJoined`, returning the same wire row
// (the MFA-secret blobs travel base64-encoded, §6) plus the session's
// `mfa_passed_at`. The repository decodes the blobs and runs the one shared
// `rowToUser` mapper — the Node-only capability canon + gravatar crypto stay in
// the Bun server.
// ---------------------------------------------------------------------------

/**
 * The joined `user + role + avatar` row the session lookup returns, shaped like
 * `convex/users.ts`'s joined row (consumed by the repository's `rowToUser`),
 * plus `session_mfa_passed_at` for the per-session MFA gate. The MFA-secret
 * `ciphertext` / `iv` are the base64 strings stored at rest; `*_json` fields are
 * already `JSON.parse`d.
 */
const sessionUserRowValidator = v.object({
  id: v.string(),
  email: v.string(),
  email_normalized: v.string(),
  display_name: v.string(),
  password_hash: v.string(),
  status: v.union(v.literal('active'), v.literal('suspended')),
  role_id: v.string(),
  last_login_at: v.union(v.null(), v.string()),
  failed_login_count: v.number(),
  locked_until: v.union(v.null(), v.string()),
  avatar_media_id: v.union(v.null(), v.string()),
  password_updated_at: v.union(v.null(), v.string()),
  mfa_enabled: v.boolean(),
  mfa_enabled_at: v.union(v.null(), v.string()),
  mfa_totp_secret_ciphertext: v.union(v.null(), v.string()),
  mfa_totp_secret_iv: v.union(v.null(), v.string()),
  mfa_totp_secret_key_fingerprint: v.union(v.null(), v.string()),
  mfa_recovery_code_hashes_json: v.any(),
  step_up_auth_mode: v.union(v.literal('required'), v.literal('disabled')),
  step_up_window_minutes: v.union(
    v.literal(5),
    v.literal(15),
    v.literal(30),
    v.literal(60),
  ),
  created_at: v.string(),
  updated_at: v.string(),
  deleted_at: v.union(v.null(), v.string()),
  role_slug: v.string(),
  role_name: v.string(),
  role_description: v.string(),
  role_is_system: v.boolean(),
  role_capabilities_json: v.any(),
  avatar_public_path: v.union(v.null(), v.string()),
  session_mfa_passed_at: v.union(v.null(), v.string()),
})

/**
 * Hand-assemble the SQL `users JOIN roles LEFT JOIN media_assets` row for a
 * session's user, tagging on the session's `mfa_passed_at`. Returns `null` when
 * the role row is missing — the SQL used an INNER join on `roles`, so such a
 * user has no hydrated view and the session lookup treats it as "not found".
 */
async function hydrateSessionUser(
  ctx: QueryCtx,
  user: Doc<'users'>,
  sessionMfaPassedAt: string | null,
) {
  const role = await ctx.db
    .query('roles')
    .withIndex('by_app_id', (q) => q.eq('id', user.role_id))
    .unique()
  if (!role) return null

  let avatarPublicPath: string | null = null
  if (user.avatar_media_id !== null) {
    const asset = await ctx.db
      .query('media_assets')
      .withIndex('by_app_id', (q) => q.eq('id', user.avatar_media_id as string))
      .unique()
    avatarPublicPath = asset ? asset.public_path : null
  }

  return {
    id: user.id,
    email: user.email,
    email_normalized: user.email_normalized,
    display_name: user.display_name,
    password_hash: user.password_hash,
    status: user.status,
    role_id: user.role_id,
    last_login_at: user.last_login_at,
    failed_login_count: user.failed_login_count,
    locked_until: user.locked_until,
    avatar_media_id: user.avatar_media_id,
    password_updated_at: user.password_updated_at,
    mfa_enabled: user.mfa_enabled,
    mfa_enabled_at: user.mfa_enabled_at,
    mfa_totp_secret_ciphertext: user.mfa_totp_secret_ciphertext,
    mfa_totp_secret_iv: user.mfa_totp_secret_iv,
    mfa_totp_secret_key_fingerprint: user.mfa_totp_secret_key_fingerprint,
    mfa_recovery_code_hashes_json: JSON.parse(
      user.mfa_recovery_code_hashes_json,
    ) as unknown,
    step_up_auth_mode: user.step_up_auth_mode,
    step_up_window_minutes: user.step_up_window_minutes,
    created_at: user.created_at,
    updated_at: user.updated_at,
    deleted_at: user.deleted_at,
    role_slug: role.slug,
    role_name: role.name,
    role_description: role.description,
    role_is_system: role.is_system,
    role_capabilities_json: JSON.parse(role.capabilities_json) as unknown,
    avatar_public_path: avatarPublicPath,
    session_mfa_passed_at: sessionMfaPassedAt,
  }
}

/** Look a session up by its app-generated `id_hash` (the `by_id_hash` index). */
function sessionByHash(ctx: QueryCtx, idHash: string) {
  return ctx.db
    .query('sessions')
    .withIndex('by_id_hash', (q) => q.eq('id_hash', idHash))
    .unique()
}

/**
 * Resolve a live session's hydrated user, or `null`.
 *
 * Replaces the SQL `sessions JOIN users JOIN roles LEFT JOIN media_assets`
 * lookup. The live-session predicate (`revoked_at is null`, `expires_at > now`,
 * `last_seen_at > idleCutoff`) and the user `status = 'active' AND deleted_at IS
 * NULL` guard are applied in-handler; ISO-8601 strings compare lexically so the
 * `>` checks match the timestamp comparisons. The `idleCutoffIso` /​ `nowIso`
 * boundaries are computed Bun-side so this stays a pure read.
 */
export const findUserRowBySessionHash = query({
  args: {
    idHash: v.string(),
    nowIso: v.string(),
    idleCutoffIso: v.string(),
  },
  returns: v.union(v.null(), sessionUserRowValidator),
  handler: async (ctx, { idHash, nowIso, idleCutoffIso }) => {
    const session = await sessionByHash(ctx, idHash)
    if (!session) return null
    if (session.revoked_at !== null) return null
    if (!(session.expires_at > nowIso)) return null
    if (!(session.last_seen_at > idleCutoffIso)) return null

    const user = await ctx.db
      .query('users')
      .withIndex('by_app_id', (q) => q.eq('id', session.user_id))
      .unique()
    if (!user || user.status !== 'active' || user.deleted_at !== null) {
      return null
    }
    return hydrateSessionUser(ctx, user, session.mfa_passed_at)
  },
})

/**
 * Insert a fresh session. `created_at` / `last_seen_at` were SQL
 * `current_timestamp` defaults and are stamped here; the token's SHA-256
 * `id_hash` and the caller-derived expiry / MFA / step-up timestamps arrive as
 * args (crypto stays Bun-side, §5).
 */
export const createSession = mutation({
  args: {
    idHash: v.string(),
    userId: v.string(),
    expiresAt: v.string(),
    ipAddress: v.union(v.null(), v.string()),
    userAgent: v.union(v.null(), v.string()),
    deviceLabel: v.string(),
    mfaPassedAt: v.union(v.null(), v.string()),
    stepUpExpiresAt: v.union(v.null(), v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    await ctx.db.insert('sessions', {
      id_hash: args.idHash,
      user_id: args.userId,
      created_at: now,
      last_seen_at: now,
      expires_at: args.expiresAt,
      revoked_at: null,
      ip_address: args.ipAddress,
      user_agent: args.userAgent,
      device_label: args.deviceLabel,
      mfa_passed_at: args.mfaPassedAt,
      step_up_expires_at: args.stepUpExpiresAt,
    })
    return null
  },
})

/**
 * Bump `last_seen_at` to now for the sliding-window idle timeout. No `revoked_at`
 * guard (the SQL had none); a missing hash is a silent no-op. The per-request
 * debounce that keeps this from firing every request lives in the repository.
 */
export const touchLastSeen = mutation({
  args: { idHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { idHash }) => {
    const session = await sessionByHash(ctx, idHash)
    if (session) {
      await ctx.db.patch(session._id, { last_seen_at: new Date().toISOString() })
    }
    return null
  },
})

/**
 * Revoke a single session by hash, unconditionally (the SQL had no `user_id`
 * guard — that variant is `revokeByHashForUser`). A missing hash is a no-op.
 */
export const revokeByHash = mutation({
  args: { idHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { idHash }) => {
    const session = await sessionByHash(ctx, idHash)
    if (session) {
      await ctx.db.patch(session._id, { revoked_at: new Date().toISOString() })
    }
    return null
  },
})

/**
 * Read a live session's `step_up_expires_at`. Returns `null` when the session
 * is missing or revoked — callers treat null as "needs step-up".
 */
export const getStepUpExpiresAt = query({
  args: { idHash: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { idHash }) => {
    const session = await sessionByHash(ctx, idHash)
    if (!session || session.revoked_at !== null) return null
    return session.step_up_expires_at
  },
})

/**
 * The token-rotation transaction (docs/CONVEX-MIGRATION.md §3 #3), as one atomic
 * mutation: read the current live session, revoke it, and insert the rotated
 * session under `nextIdHash` carrying the same user / expiry / device. The
 * inherited identity is preserved exactly — the whole handler is the
 * transaction, so the old row's revoke and the new row's insert can never be
 * observed apart.
 *
 * `mfaPassedAt` / `stepUpExpiresAt` are tri-state: omitted ⇒ inherit the current
 * row's value, present (incl. `null`) ⇒ override. Returns the inherited
 * `expiresAt`, or `null` when there is no live session to rotate.
 */
export const rotate = mutation({
  args: {
    currentIdHash: v.string(),
    nextIdHash: v.string(),
    mfaPassedAt: v.optional(v.union(v.null(), v.string())),
    stepUpExpiresAt: v.optional(v.union(v.null(), v.string())),
  },
  returns: v.union(v.null(), v.object({ expiresAt: v.string() })),
  handler: async (ctx, args) => {
    const current = await sessionByHash(ctx, args.currentIdHash)
    if (!current || current.revoked_at !== null) return null

    const now = new Date().toISOString()
    await ctx.db.patch(current._id, { revoked_at: now })

    const mfaPassedAt =
      args.mfaPassedAt !== undefined ? args.mfaPassedAt : current.mfa_passed_at
    const stepUpExpiresAt =
      args.stepUpExpiresAt !== undefined
        ? args.stepUpExpiresAt
        : current.step_up_expires_at

    await ctx.db.insert('sessions', {
      id_hash: args.nextIdHash,
      user_id: current.user_id,
      created_at: now,
      last_seen_at: now,
      expires_at: current.expires_at,
      revoked_at: null,
      ip_address: current.ip_address,
      user_agent: current.user_agent,
      device_label: current.device_label,
      mfa_passed_at: mfaPassedAt,
      step_up_expires_at: stepUpExpiresAt,
    })

    return { expiresAt: current.expires_at }
  },
})

/**
 * Stamp `mfa_passed_at` (and refresh `last_seen_at`) on a live session after a
 * successful MFA challenge. No-op when the session is missing or revoked (the
 * SQL carried `and revoked_at is null`).
 */
export const markMfaPassed = mutation({
  args: { idHash: v.string(), passedAt: v.string() },
  returns: v.null(),
  handler: async (ctx, { idHash, passedAt }) => {
    const session = await sessionByHash(ctx, idHash)
    if (session && session.revoked_at === null) {
      await ctx.db.patch(session._id, {
        mfa_passed_at: passedAt,
        last_seen_at: new Date().toISOString(),
      })
    }
    return null
  },
})
