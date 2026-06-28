/**
 * Plugin secret settings — Convex functions for `plugin_secrets` (one row per
 * (plugin_id, setting_id): AES-GCM ciphertext + iv + key fingerprint).
 *
 * The Convex half of the `pluginSecrets` domain; the thin repository adapter
 * (`server/repositories/pluginSecrets.ts`) owns all crypto and the `'***'`
 * sentinel semantics. The split is deliberate and load-bearing:
 *
 * - **Encryption stays Bun-side, NEVER in the Convex V8 runtime** (§6). The
 *   repository encrypts/decrypts with the process master key and crosses the
 *   wire with `ciphertext` / `iv` as **base64 strings** (the schema stores them
 *   base64-encoded, not as `bytea`/blob). Convex only persists and returns
 *   those strings — it never sees the master key or any plaintext.
 * - **No `ON CONFLICT`.** `upsert` is read-by-`by_plugin_setting` →
 *   patch-or-insert (§4.6); `seedDefault` is insert-if-absent (the SQL
 *   `on conflict do nothing`), so upgrade/rollback never clobbers a rotated
 *   secret.
 *
 * `created_at` / `updated_at` (SQL column defaults) are stamped here. Convex
 * `_id` never leaks out. Every function declares both `args` AND `returns`
 * validators.
 *
 * @see server/repositories/pluginSecrets.ts — the Bun-side crypto adapter
 */

import { v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

function secretByKey(ctx: QueryCtx | MutationCtx, pluginId: string, settingId: string) {
  return ctx.db
    .query('plugin_secrets')
    .withIndex('by_plugin_setting', (q) =>
      q.eq('plugin_id', pluginId).eq('setting_id', settingId),
    )
    .unique()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Per-setting presence + fingerprint (the wire-safe state projection). The
 * repository compares each `key_fingerprint` to the live master-key fingerprint
 * Bun-side — no ciphertext crosses. Ordered by setting id (the SQL `order by`).
 */
export const listStates = query({
  args: { pluginId: v.string() },
  returns: v.array(v.object({ setting_id: v.string(), key_fingerprint: v.string() })),
  handler: async (ctx, { pluginId }) => {
    const rows = await ctx.db
      .query('plugin_secrets')
      .withIndex('by_plugin', (q) => q.eq('plugin_id', pluginId))
      .collect()
    rows.sort((a, b) => (a.setting_id < b.setting_id ? -1 : a.setting_id > b.setting_id ? 1 : 0))
    return rows.map((row) => ({
      setting_id: row.setting_id,
      key_fingerprint: row.key_fingerprint,
    }))
  },
})

/**
 * All encrypted secrets for a plugin (base64 `ciphertext` / `iv` + fingerprint).
 * SERVER-SIDE RUNTIME USE ONLY: the repository decodes the base64 to bytes and
 * decrypts with the master key — this shape must never reach a browser.
 */
export const listForRuntime = query({
  args: { pluginId: v.string() },
  returns: v.array(
    v.object({
      setting_id: v.string(),
      ciphertext: v.string(),
      iv: v.string(),
      key_fingerprint: v.string(),
    }),
  ),
  handler: async (ctx, { pluginId }) => {
    const rows = await ctx.db
      .query('plugin_secrets')
      .withIndex('by_plugin', (q) => q.eq('plugin_id', pluginId))
      .collect()
    return rows.map((row) => ({
      setting_id: row.setting_id,
      ciphertext: row.ciphertext,
      iv: row.iv,
      key_fingerprint: row.key_fingerprint,
    }))
  },
})

// ---------------------------------------------------------------------------
// Writes (ciphertext / iv arrive base64-encoded — crypto ran Bun-side)
// ---------------------------------------------------------------------------

/**
 * Upsert one encrypted secret by (plugin_id, setting_id) — read-by-index →
 * patch-or-insert (§4.6, the SQL `on conflict do update`). `created_at` /
 * `updated_at` are stamped here.
 */
export const upsert = mutation({
  args: {
    pluginId: v.string(),
    settingId: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    keyFingerprint: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const existing = await secretByKey(ctx, args.pluginId, args.settingId)
    if (existing) {
      await ctx.db.patch(existing._id, {
        ciphertext: args.ciphertext,
        iv: args.iv,
        key_fingerprint: args.keyFingerprint,
        updated_at: now,
      })
      return null
    }
    await ctx.db.insert('plugin_secrets', {
      plugin_id: args.pluginId,
      setting_id: args.settingId,
      ciphertext: args.ciphertext,
      iv: args.iv,
      key_fingerprint: args.keyFingerprint,
      created_at: now,
      updated_at: now,
    })
    return null
  },
})

/**
 * Seed a secret default ONLY if no row exists for (plugin_id, setting_id) — the
 * SQL `on conflict do nothing`, so a rotated secret survives upgrade/rollback.
 */
export const seedDefault = mutation({
  args: {
    pluginId: v.string(),
    settingId: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    keyFingerprint: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await secretByKey(ctx, args.pluginId, args.settingId)
    if (existing) return null
    const now = new Date().toISOString()
    await ctx.db.insert('plugin_secrets', {
      plugin_id: args.pluginId,
      setting_id: args.settingId,
      ciphertext: args.ciphertext,
      iv: args.iv,
      key_fingerprint: args.keyFingerprint,
      created_at: now,
      updated_at: now,
    })
    return null
  },
})

/** Delete one secret by (plugin_id, setting_id). No-op if absent. */
export const remove = mutation({
  args: { pluginId: v.string(), settingId: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId, settingId }) => {
    const row = await secretByKey(ctx, pluginId, settingId)
    if (row) await ctx.db.delete(row._id)
    return null
  },
})
