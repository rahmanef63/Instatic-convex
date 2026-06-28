/**
 * Users / identity — Convex functions.
 *
 * The Convex half of the `users` domain; the thin repository adapter
 * (`server/repositories/users.ts`) marshals args into these and maps their
 * results back into the frozen `AuthUser` / `CmsUser` shapes. The split is:
 *
 * - **Hydration stays in the repository.** Every read here returns a *joined
 *   row* — the user columns + its role columns + its avatar `public_path` —
 *   shaped exactly like the repository's `JoinedUserRow`. The repository's
 *   existing `rowToUser` then maps that row to `AuthUser` (capability
 *   normalisation, recovery-code parsing, step-up normalisation, gravatar
 *   hashing, `EncryptedTotpSecret` assembly). This keeps ONE hydration path —
 *   the same `rowToUser` the still-SQL session lookup in
 *   `server/auth/sessions.ts` uses — and keeps Node-only crypto
 *   (`computeGravatarHash`) and the `@core` capability canon out of the Convex
 *   runtime, where they don't belong.
 * - **The SQL `LEFT JOIN roles` / `LEFT JOIN media_assets` becomes a
 *   hand-assembled join** (`hydrateJoined`): fetch the user by index, then the
 *   role + avatar by index, merge in JS (docs/CONVEX-MIGRATION.md §4.2). The
 *   SQL was an INNER `join roles`, so a user whose role row is missing hydrates
 *   to `null` — the same "row disappears" semantics the inner join had.
 *
 * Conventions (docs/CONVEX-MIGRATION.md §2, §4, §6):
 * - App identity is the nanoid `id`, generated here on insert (replaces the old
 *   `${nanoid()}` default); `created_at` / `updated_at` / `password_updated_at`
 *   replace SQL `current_timestamp` / column defaults and are stamped here.
 *   Convex `_id` never leaks out.
 * - Each `db.transaction`-equivalent (none of these used one — they were single
 *   statements) plus its read-after-write reload collapses into ONE atomic
 *   mutation: write, then re-hydrate and return the joined row.
 * - `*_json` blobs (`mfa_recovery_code_hashes_json`, `capabilities_json`) are
 *   opaque `v.string()` at rest; they are `JSON.parse`d here into the array
 *   shape `rowToUser` expects (the old SQLite adapter auto-parsed `*_json`).
 * - The MFA secret `ciphertext` / `iv` are AES-GCM bytes; the schema stores
 *   them base64-encoded (§6). They travel as base64 strings on this channel and
 *   are decoded to `Uint8Array` in the repository — Convex's V8 runtime never
 *   touches the master key, so all TOTP crypto stays in the Bun server.
 * - The partial-unique `users_email_normalized_active_idx WHERE deleted_at IS
 *   NULL` has no Convex equivalent (§4.6): it is enforced by an explicit
 *   pre-write read of the `by_email_normalized` index inside the mutation.
 * - Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/users.ts  — the thin repository adapter
 * @see server/auth/sessions.ts       — the (still-SQL) session lookup that
 *                                       shares `rowToUser`
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

const statusValidator = v.union(v.literal('active'), v.literal('suspended'))
const stepUpModeValidator = v.union(v.literal('required'), v.literal('disabled'))
const stepUpWindowValidator = v.union(
  v.literal(5),
  v.literal(15),
  v.literal(30),
  v.literal(60),
)

/**
 * The joined `user + role + avatar` row the repository's `rowToUser` consumes
 * (its `JoinedUserRow`). `mfa_totp_secret_ciphertext` / `_iv` are the base64
 * strings stored at rest (decoded to bytes in the repo); the two `*_json`
 * fields are already `JSON.parse`d into their array values here.
 */
const joinedUserRowValidator = v.object({
  id: v.string(),
  email: v.string(),
  email_normalized: v.string(),
  display_name: v.string(),
  password_hash: v.string(),
  status: statusValidator,
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
  step_up_auth_mode: stepUpModeValidator,
  step_up_window_minutes: stepUpWindowValidator,
  created_at: v.string(),
  updated_at: v.string(),
  deleted_at: v.union(v.null(), v.string()),
  role_slug: v.string(),
  role_name: v.string(),
  role_description: v.string(),
  role_is_system: v.boolean(),
  role_capabilities_json: v.any(),
  avatar_public_path: v.union(v.null(), v.string()),
})

/** Look a user up by its app-generated nanoid id (the `by_id` index). */
function userByAppId(ctx: QueryCtx, id: string) {
  return ctx.db
    .query('users')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

/**
 * Hand-assemble the SQL `users JOIN roles LEFT JOIN media_assets` row. Returns
 * `null` when the user's role row is missing — the SQL used an INNER join on
 * `roles`, so such a user has no hydrated view (and the caller treats it as
 * "not found", matching the old behaviour).
 */
async function hydrateJoined(ctx: QueryCtx, user: Doc<'users'>) {
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
    mfa_recovery_code_hashes_json: JSON.parse(user.mfa_recovery_code_hashes_json) as unknown,
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
  }
}

/** Re-read a just-written user doc and hydrate it (returns `null` if its role vanished). */
async function reloadJoined(ctx: QueryCtx, docId: Doc<'users'>['_id']) {
  const fresh = await ctx.db.get(docId)
  if (!fresh) return null
  return hydrateJoined(ctx, fresh)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All non-deleted users, oldest first (the SQL `order by created_at asc`). */
export const list = query({
  args: {},
  returns: v.array(joinedUserRowValidator),
  handler: async (ctx) => {
    const users = await ctx.db.query('users').collect()
    const live = users
      .filter((u) => u.deleted_at === null)
      .sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      )
    const rows = []
    for (const user of live) {
      const row = await hydrateJoined(ctx, user)
      if (row) rows.push(row)
    }
    return rows
  },
})

/** Hydrate a single non-deleted user by app id, or `null`. */
export const findById = query({
  args: { userId: v.string() },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, { userId }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null) return null
    return hydrateJoined(ctx, user)
  },
})

/** Hydrate a single non-deleted user by normalized email, or `null`. */
export const findByEmail = query({
  args: { emailNormalized: v.string() },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, { emailNormalized }) => {
    const matches = await ctx.db
      .query('users')
      .withIndex('by_email_normalized', (q) =>
        q.eq('email_normalized', emailNormalized),
      )
      .collect()
    const user = matches.find((u) => u.deleted_at === null)
    if (!user) return null
    return hydrateJoined(ctx, user)
  },
})

/** Count active, non-deleted users in the `owner` role (the SQL `COUNT(*)`). */
export const countActiveOwners = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const owners = await ctx.db
      .query('users')
      .withIndex('by_role_id', (q) => q.eq('role_id', 'owner'))
      .collect()
    return owners.filter((u) => u.status === 'active' && u.deleted_at === null)
      .length
  },
})

// ---------------------------------------------------------------------------
// Writes (each: validity guard → write → re-hydrate, all atomic)
// ---------------------------------------------------------------------------

/**
 * Insert a user. `id` is generated here when not supplied; `created_at` /
 * `updated_at` are stamped here; the remaining columns take the old SQL
 * defaults (`failed_login_count` 0, `mfa_recovery_code_hashes_json` `'[]'`,
 * `step_up_auth_mode` `'required'`, `step_up_window_minutes` 15). Rejects a
 * duplicate active email (the SQL partial-unique index, §4.6). Returns the
 * hydrated joined row, or `null` if its role row is missing (so the repository
 * can raise the same "User was not created" error the old reload did).
 */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    email: v.string(),
    emailNormalized: v.string(),
    displayName: v.string(),
    passwordHash: v.string(),
    status: statusValidator,
    roleId: v.string(),
  },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('users')
      .withIndex('by_email_normalized', (q) =>
        q.eq('email_normalized', args.emailNormalized),
      )
      .collect()
    if (existing.some((u) => u.deleted_at === null)) {
      throw new Error('A user with this email already exists')
    }

    const now = new Date().toISOString()
    const docId = await ctx.db.insert('users', {
      id: args.id ?? nanoid(),
      email: args.email,
      email_normalized: args.emailNormalized,
      display_name: args.displayName,
      password_hash: args.passwordHash,
      status: args.status,
      role_id: args.roleId,
      last_login_at: null,
      failed_login_count: 0,
      locked_until: null,
      password_updated_at: null,
      mfa_enabled: false,
      mfa_enabled_at: null,
      mfa_totp_secret_ciphertext: null,
      mfa_totp_secret_iv: null,
      mfa_totp_secret_key_fingerprint: null,
      mfa_recovery_code_hashes_json: '[]',
      created_at: now,
      updated_at: now,
      deleted_at: null,
      avatar_media_id: null,
      step_up_auth_mode: 'required',
      step_up_window_minutes: 15,
    })
    return reloadJoined(ctx, docId)
  },
})

/**
 * Overwrite the core profile fields. The repository has already merged the
 * incoming patch over the current row (and validated the email), so every
 * field is passed fully resolved. Rejects a collision with another active
 * user's email. Returns the re-hydrated row, or `null` when the target is
 * missing / soft-deleted.
 */
export const update = mutation({
  args: {
    userId: v.string(),
    email: v.string(),
    emailNormalized: v.string(),
    displayName: v.string(),
    passwordHash: v.string(),
    passwordUpdatedAt: v.union(v.null(), v.string()),
    status: statusValidator,
    roleId: v.string(),
  },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, args) => {
    const user = await userByAppId(ctx, args.userId)
    if (!user || user.deleted_at !== null) return null

    const collision = await ctx.db
      .query('users')
      .withIndex('by_email_normalized', (q) =>
        q.eq('email_normalized', args.emailNormalized),
      )
      .collect()
    if (collision.some((u) => u.deleted_at === null && u.id !== args.userId)) {
      throw new Error('A user with this email already exists')
    }

    await ctx.db.patch(user._id, {
      email: args.email,
      email_normalized: args.emailNormalized,
      display_name: args.displayName,
      password_hash: args.passwordHash,
      password_updated_at: args.passwordUpdatedAt,
      status: args.status,
      role_id: args.roleId,
      updated_at: new Date().toISOString(),
    })
    return reloadJoined(ctx, user._id)
  },
})

/** Point the avatar reference at a media asset (or clear it). */
export const setAvatarMediaId = mutation({
  args: { userId: v.string(), mediaId: v.union(v.null(), v.string()) },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, { userId, mediaId }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null) return null
    await ctx.db.patch(user._id, {
      avatar_media_id: mediaId,
      updated_at: new Date().toISOString(),
    })
    return reloadJoined(ctx, user._id)
  },
})

/** Replace the password hash and stamp `password_updated_at` to now. */
export const updatePasswordHash = mutation({
  args: { userId: v.string(), passwordHash: v.string() },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, { userId, passwordHash }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null) return null
    const now = new Date().toISOString()
    await ctx.db.patch(user._id, {
      password_hash: passwordHash,
      password_updated_at: now,
      updated_at: now,
    })
    return reloadJoined(ctx, user._id)
  },
})

/**
 * Enable TOTP MFA. The repository encrypts the secret with the Bun-side master
 * key and passes the AES-GCM `ciphertext` / `iv` as base64 strings (stored
 * verbatim) plus the fresh recovery-code hashes.
 */
export const enableTotpMfa = mutation({
  args: {
    userId: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    keyFingerprint: v.union(v.null(), v.string()),
    recoveryCodeHashes: v.array(v.string()),
  },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, args) => {
    const user = await userByAppId(ctx, args.userId)
    if (!user || user.deleted_at !== null) return null
    const now = new Date().toISOString()
    await ctx.db.patch(user._id, {
      mfa_enabled: true,
      mfa_enabled_at: now,
      mfa_totp_secret_ciphertext: args.ciphertext,
      mfa_totp_secret_iv: args.iv,
      mfa_totp_secret_key_fingerprint: args.keyFingerprint,
      mfa_recovery_code_hashes_json: JSON.stringify(args.recoveryCodeHashes),
      updated_at: now,
    })
    return reloadJoined(ctx, user._id)
  },
})

/** Disable TOTP MFA: clear the secret + fingerprint and reset recovery codes. */
export const disableTotpMfa = mutation({
  args: { userId: v.string() },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, { userId }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null) return null
    await ctx.db.patch(user._id, {
      mfa_enabled: false,
      mfa_enabled_at: null,
      mfa_totp_secret_ciphertext: null,
      mfa_totp_secret_iv: null,
      mfa_totp_secret_key_fingerprint: null,
      mfa_recovery_code_hashes_json: '[]',
      updated_at: new Date().toISOString(),
    })
    return reloadJoined(ctx, user._id)
  },
})

/**
 * Replace the recovery-code hash list. No-op (returns `null`) unless MFA is
 * currently enabled — the SQL carried `and mfa_enabled = true` in its WHERE.
 */
export const replaceRecoveryCodeHashes = mutation({
  args: { userId: v.string(), recoveryCodeHashes: v.array(v.string()) },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, { userId, recoveryCodeHashes }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null || !user.mfa_enabled) return null
    await ctx.db.patch(user._id, {
      mfa_recovery_code_hashes_json: JSON.stringify(recoveryCodeHashes),
      updated_at: new Date().toISOString(),
    })
    return reloadJoined(ctx, user._id)
  },
})

/** Update the per-user step-up freshness policy. */
export const updateStepUpPolicy = mutation({
  args: {
    userId: v.string(),
    mode: stepUpModeValidator,
    windowMinutes: stepUpWindowValidator,
  },
  returns: v.union(v.null(), joinedUserRowValidator),
  handler: async (ctx, { userId, mode, windowMinutes }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null) return null
    await ctx.db.patch(user._id, {
      step_up_auth_mode: mode,
      step_up_window_minutes: windowMinutes,
      updated_at: new Date().toISOString(),
    })
    return reloadJoined(ctx, user._id)
  },
})

/**
 * Consume one recovery-code hash, atomically. Returns `true` only when the
 * user exists (non-deleted), still has MFA enabled, and the hash was present in
 * the list — mirroring the SQL read-then-`update … and mfa_enabled = true`.
 */
export const consumeRecoveryCodeHash = mutation({
  args: { userId: v.string(), usedHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId, usedHash }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null || !user.mfa_enabled) return false
    const hashes = JSON.parse(user.mfa_recovery_code_hashes_json) as unknown
    if (!Array.isArray(hashes) || !hashes.includes(usedHash)) return false
    const remaining = hashes.filter((hash) => hash !== usedHash)
    await ctx.db.patch(user._id, {
      mfa_recovery_code_hashes_json: JSON.stringify(remaining),
      updated_at: new Date().toISOString(),
    })
    return true
  },
})

/** Soft-delete a user. Returns `true` only when a live row was actually deleted. */
export const softDelete = mutation({
  args: { userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null) return false
    const now = new Date().toISOString()
    await ctx.db.patch(user._id, { deleted_at: now, updated_at: now })
    return true
  },
})

/**
 * Stamp a successful login: bump `last_login_at`, clear the failed-attempt
 * counter and any lockout. Matches the SQL's lack of a `deleted_at` guard.
 */
export const markLoggedIn = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const user = await userByAppId(ctx, userId)
    if (!user) return null
    const now = new Date().toISOString()
    await ctx.db.patch(user._id, {
      last_login_at: now,
      failed_login_count: 0,
      locked_until: null,
      updated_at: now,
    })
    return null
  },
})

/**
 * Increment the failed-login counter and persist the (possibly null) lockout
 * deadline, atomically. Returns the post-update counter + lockout, or `null`
 * when the user is missing / soft-deleted.
 */
export const recordFailedLoginAttempt = mutation({
  args: { userId: v.string(), lockedUntil: v.union(v.null(), v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      failedLoginCount: v.number(),
      lockedUntil: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx, { userId, lockedUntil }) => {
    const user = await userByAppId(ctx, userId)
    if (!user || user.deleted_at !== null) return null
    const failedLoginCount = user.failed_login_count + 1
    await ctx.db.patch(user._id, {
      failed_login_count: failedLoginCount,
      locked_until: lockedUntil,
      updated_at: new Date().toISOString(),
    })
    return { failedLoginCount, lockedUntil }
  },
})
