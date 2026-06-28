/**
 * AI provider credentials — Convex functions.
 *
 * The Convex half of the `ai_provider_credentials` domain; the thin repository
 * adapter (`server/ai/credentials/store.ts`) marshals args into these and maps
 * the results back into the frozen `CredentialRecord` / `CredentialView` shapes
 * (docs/CONVEX-MIGRATION.md §2).
 *
 * - **Crypto stays Bun-side.** The AES-256-GCM `ciphertext` / `iv` are produced
 *   by the repository with the server master key and travel here as **base64
 *   strings** (§6); they are stored verbatim and never decrypted in Convex's V8
 *   runtime, which never sees the master key. The repository decodes them back
 *   to `Uint8Array` on read.
 * - **Uniqueness has no Convex equivalent** (§4.6): the SQL unique
 *   `(user_id, provider_id, display_label)` index is enforced by an explicit
 *   pre-write read of `by_user_label` inside `create` / `update`; a collision
 *   returns `{ ok: false, reason: 'duplicate' }` so the repository raises the
 *   same `CredentialError` (409) with its label-specific message.
 * - **No FK cascade/restrict** (§4.x): the SQL `ai_defaults.credential_id` FK
 *   `on delete restrict` is replaced by an explicit `by_credential` read in
 *   `remove`; a referenced credential returns `'in_use'` so the repository
 *   raises the same `CredentialError` (409).
 *
 * App identity is the nanoid `id`, generated here; `created_at` / `updated_at`
 * (SQL column defaults) are stamped here. Convex `_id` never leaks out. Every
 * function declares both `args` AND `returns` validators.
 *
 * @see server/ai/credentials/store.ts — the thin repository adapter (encryption)
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

const authModeValidator = v.union(v.literal('apiKey'), v.literal('baseUrl'))

/**
 * Shaped exactly like the repository's `CredentialRow`, except `ciphertext` /
 * `iv` are the base64 strings stored at rest (decoded to bytes in the repo).
 */
const credentialRowValidator = v.object({
  id: v.string(),
  user_id: v.string(),
  provider_id: v.string(),
  auth_mode: authModeValidator,
  display_label: v.string(),
  ciphertext: v.union(v.null(), v.string()),
  iv: v.union(v.null(), v.string()),
  base_url: v.union(v.null(), v.string()),
  key_fingerprint: v.union(v.null(), v.string()),
  created_at: v.string(),
  updated_at: v.string(),
  last_used_at: v.union(v.null(), v.string()),
})

function credentialByAppId(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db
    .query('ai_provider_credentials')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

function toCredentialRow(row: Doc<'ai_provider_credentials'>) {
  return {
    id: row.id,
    user_id: row.user_id,
    provider_id: row.provider_id,
    auth_mode: row.auth_mode,
    display_label: row.display_label,
    ciphertext: row.ciphertext,
    iv: row.iv,
    base_url: row.base_url,
    key_fingerprint: row.key_fingerprint,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_used_at: row.last_used_at,
  }
}

/** True when an active row already owns this `(user_id, provider_id, label)` key. */
async function labelTaken(
  ctx: MutationCtx,
  userId: string,
  providerId: string,
  displayLabel: string,
  exceptId: string | null,
): Promise<boolean> {
  const rows = await ctx.db
    .query('ai_provider_credentials')
    .withIndex('by_user_label', (q) =>
      q.eq('user_id', userId).eq('provider_id', providerId).eq('display_label', displayLabel),
    )
    .collect()
  return rows.some((r) => r.id !== exceptId)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every credential owned by `userId`, newest first. The `auth_mode` filter
 * mirrors the SQL `in ('apiKey', 'baseUrl')` guard so a stale row carrying a
 * retired mode never reaches the wire.
 */
export const listForUser = query({
  args: { userId: v.string() },
  returns: v.array(credentialRowValidator),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query('ai_provider_credentials')
      .withIndex('by_user', (q) => q.eq('user_id', userId))
      .collect()
    return rows
      .filter((r) => r.auth_mode === 'apiKey' || r.auth_mode === 'baseUrl')
      .sort((a, b) =>
        a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
      )
      .map(toCredentialRow)
  },
})

/** Read a single credential with the `user_id` cross-user guard, or `null`. */
export const readForUser = query({
  args: { userId: v.string(), credentialId: v.string() },
  returns: v.union(v.null(), credentialRowValidator),
  handler: async (ctx, { userId, credentialId }) => {
    const row = await credentialByAppId(ctx, credentialId)
    if (!row || row.user_id !== userId) return null
    return toCredentialRow(row)
  },
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const createResult = v.union(
  v.object({ ok: v.literal(true), row: credentialRowValidator }),
  v.object({ ok: v.literal(false), reason: v.literal('duplicate') }),
)

/**
 * Insert a credential. The repository has already encrypted any secret material
 * (base64 `ciphertext` / `iv`) and computed the fingerprint. Rejects a duplicate
 * `(user_id, provider_id, display_label)` (the SQL unique index, §4.6).
 */
export const create = mutation({
  args: {
    userId: v.string(),
    providerId: v.string(),
    authMode: authModeValidator,
    displayLabel: v.string(),
    ciphertext: v.union(v.null(), v.string()),
    iv: v.union(v.null(), v.string()),
    baseUrl: v.union(v.null(), v.string()),
    keyFingerprint: v.union(v.null(), v.string()),
  },
  returns: createResult,
  handler: async (ctx, args) => {
    if (await labelTaken(ctx, args.userId, args.providerId, args.displayLabel, null)) {
      return { ok: false as const, reason: 'duplicate' as const }
    }
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('ai_provider_credentials', {
      id: nanoid(),
      user_id: args.userId,
      provider_id: args.providerId,
      auth_mode: args.authMode,
      display_label: args.displayLabel,
      ciphertext: args.ciphertext,
      iv: args.iv,
      base_url: args.baseUrl,
      key_fingerprint: args.keyFingerprint,
      created_at: now,
      updated_at: now,
      last_used_at: null,
    })
    const fresh = await ctx.db.get(docId)
    return { ok: true as const, row: toCredentialRow(fresh!) }
  },
})

const updateResult = v.union(
  v.object({ ok: v.literal(true), row: credentialRowValidator }),
  v.object({ ok: v.literal(false), reason: v.union(v.literal('duplicate'), v.literal('not_found')) }),
)

/**
 * Patch a credential's mutable fields (auth mode is immutable). The repository
 * has resolved the next ciphertext / iv / fingerprint / base url. Rejects a
 * collision with another active credential's label.
 */
export const update = mutation({
  args: {
    userId: v.string(),
    credentialId: v.string(),
    displayLabel: v.string(),
    ciphertext: v.union(v.null(), v.string()),
    iv: v.union(v.null(), v.string()),
    baseUrl: v.union(v.null(), v.string()),
    keyFingerprint: v.union(v.null(), v.string()),
  },
  returns: updateResult,
  handler: async (ctx, args) => {
    const row = await credentialByAppId(ctx, args.credentialId)
    if (!row || row.user_id !== args.userId) {
      return { ok: false as const, reason: 'not_found' as const }
    }
    if (
      await labelTaken(ctx, args.userId, row.provider_id, args.displayLabel, args.credentialId)
    ) {
      return { ok: false as const, reason: 'duplicate' as const }
    }
    await ctx.db.patch(row._id, {
      display_label: args.displayLabel,
      ciphertext: args.ciphertext,
      iv: args.iv,
      base_url: args.baseUrl,
      key_fingerprint: args.keyFingerprint,
      updated_at: new Date().toISOString(),
    })
    const fresh = await ctx.db.get(row._id)
    return { ok: true as const, row: toCredentialRow(fresh!) }
  },
})

/**
 * Hard-delete a credential. Replaces the SQL FK `on delete restrict` on
 * `ai_defaults`: a credential referenced by any scope default returns
 * `'in_use'`; otherwise `'deleted'` / `'not_found'`.
 */
export const remove = mutation({
  args: { userId: v.string(), credentialId: v.string() },
  returns: v.union(v.literal('deleted'), v.literal('not_found'), v.literal('in_use')),
  handler: async (ctx, { userId, credentialId }) => {
    const row = await credentialByAppId(ctx, credentialId)
    if (!row || row.user_id !== userId) return 'not_found' as const
    const referencing = await ctx.db
      .query('ai_defaults')
      .withIndex('by_credential', (q) => q.eq('credential_id', credentialId))
      .first()
    if (referencing) return 'in_use' as const
    await ctx.db.delete(row._id)
    return 'deleted' as const
  },
})

/** Touch `last_used_at`. Best-effort — silent no-op if the row vanished. */
export const touchLastUsed = mutation({
  args: { credentialId: v.string() },
  returns: v.null(),
  handler: async (ctx, { credentialId }) => {
    const row = await credentialByAppId(ctx, credentialId)
    if (row) await ctx.db.patch(row._id, { last_used_at: new Date().toISOString() })
    return null
  },
})
