/**
 * Media storage-adapter + variant-delegate election — Convex functions.
 *
 * The Convex half of the two singleton-ish election tables; the thin repository
 * adapter (`server/repositories/mediaStorageAdapters.ts`) marshals args into
 * these and maps the rows back through its pure `mapRow` / `mapVariantDelegateRow`
 * hydrators.
 *
 * - `active_media_storage_adapter`: one row per role (`role` is the natural key).
 *   A missing row defaults to `''` (local-disk).
 * - `active_media_variant_delegate`: a singleton (`singleton = 1`).
 *
 * Convex has no `ON CONFLICT` (§4.6) and no unique index, so both elections are
 * read-by-index → patch-or-insert inside one atomic mutation. `widths_json` /
 * `formats_json` are opaque JSON strings at rest (§6); the repository's parsers
 * accept either a string or a parsed array, so the arrays are `JSON.stringify`d
 * here on write and returned verbatim on read.
 *
 * Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/mediaStorageAdapters.ts — the thin repository adapter
 */

import { v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'

// ---------------------------------------------------------------------------
// Per-role storage adapter
// ---------------------------------------------------------------------------

const electedAdapterRowValidator = v.object({
  role: v.string(),
  adapter_id: v.string(),
  elected_at: v.string(),
  elected_by_user_id: v.union(v.null(), v.string()),
})

function adapterByRole(ctx: QueryCtx | MutationCtx, role: string) {
  return ctx.db
    .query('active_media_storage_adapter')
    .withIndex('by_role', (q) => q.eq('role', role))
    .unique()
}

/** Elected adapter id for a role, or `''` (local-disk) when no row exists. */
export const getElectedAdapterId = query({
  args: { role: v.string() },
  returns: v.string(),
  handler: async (ctx, { role }) => {
    const row = await adapterByRole(ctx, role)
    return row ? row.adapter_id : ''
  },
})

/** Every elected adapter row (only roles that have been set). */
export const listElectedAdapters = query({
  args: {},
  returns: v.array(electedAdapterRowValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query('active_media_storage_adapter').collect()
    return rows.map((r) => ({
      role: r.role,
      adapter_id: r.adapter_id,
      elected_at: r.elected_at,
      elected_by_user_id: r.elected_by_user_id,
    }))
  },
})

/** Elect (upsert) an adapter for a role; empty `adapterId` resets to local-disk. */
export const electAdapter = mutation({
  args: {
    role: v.string(),
    adapterId: v.string(),
    userId: v.union(v.null(), v.string()),
  },
  returns: electedAdapterRowValidator,
  handler: async (ctx, { role, adapterId, userId }) => {
    const nowIso = new Date().toISOString()
    const existing = await adapterByRole(ctx, role)
    if (existing) {
      await ctx.db.patch(existing._id, {
        adapter_id: adapterId,
        elected_at: nowIso,
        elected_by_user_id: userId,
      })
    } else {
      await ctx.db.insert('active_media_storage_adapter', {
        role,
        adapter_id: adapterId,
        elected_at: nowIso,
        elected_by_user_id: userId,
      })
    }
    return {
      role,
      adapter_id: adapterId,
      elected_at: nowIso,
      elected_by_user_id: userId,
    }
  },
})

/** How many `media_assets` rows are written by a given adapter id. */
export const countAssetsForAdapter = query({
  args: { adapterId: v.string() },
  returns: v.number(),
  handler: async (ctx, { adapterId }) => {
    const rows = await ctx.db
      .query('media_assets')
      .withIndex('by_storage_adapter', (q) => q.eq('storage_adapter_id', adapterId))
      .collect()
    return rows.length
  },
})

// ---------------------------------------------------------------------------
// Variant delegate (singleton)
// ---------------------------------------------------------------------------

const variantDelegateRowValidator = v.object({
  delegate_id: v.string(),
  variant_url_template: v.string(),
  widths_json: v.string(),
  formats_json: v.string(),
  elected_at: v.string(),
  elected_by_user_id: v.union(v.null(), v.string()),
})

function variantDelegateRow(ctx: QueryCtx | MutationCtx) {
  return ctx.db
    .query('active_media_variant_delegate')
    .withIndex('by_singleton', (q) => q.eq('singleton', 1))
    .unique()
}

/** The currently-elected variant delegate, or `null` (host falls back to local). */
export const getElectedVariantDelegate = query({
  args: {},
  returns: v.union(v.null(), variantDelegateRowValidator),
  handler: async (ctx) => {
    const row = await variantDelegateRow(ctx)
    if (!row) return null
    return {
      delegate_id: row.delegate_id,
      variant_url_template: row.variant_url_template,
      widths_json: row.widths_json,
      formats_json: row.formats_json,
      elected_at: row.elected_at,
      elected_by_user_id: row.elected_by_user_id,
    }
  },
})

/** Elect (upsert) the singleton variant delegate. */
export const electVariantDelegate = mutation({
  args: {
    delegateId: v.string(),
    variantUrlTemplate: v.string(),
    widths: v.array(v.number()),
    formats: v.array(v.string()),
    userId: v.union(v.null(), v.string()),
  },
  returns: variantDelegateRowValidator,
  handler: async (ctx, args) => {
    const nowIso = new Date().toISOString()
    const widthsJson = JSON.stringify(args.widths)
    const formatsJson = JSON.stringify(args.formats)
    const existing = await variantDelegateRow(ctx)
    if (existing) {
      await ctx.db.patch(existing._id, {
        delegate_id: args.delegateId,
        variant_url_template: args.variantUrlTemplate,
        widths_json: widthsJson,
        formats_json: formatsJson,
        elected_at: nowIso,
        elected_by_user_id: args.userId,
      })
    } else {
      await ctx.db.insert('active_media_variant_delegate', {
        singleton: 1,
        delegate_id: args.delegateId,
        variant_url_template: args.variantUrlTemplate,
        widths_json: widthsJson,
        formats_json: formatsJson,
        elected_at: nowIso,
        elected_by_user_id: args.userId,
      })
    }
    return {
      delegate_id: args.delegateId,
      variant_url_template: args.variantUrlTemplate,
      widths_json: widthsJson,
      formats_json: formatsJson,
      elected_at: nowIso,
      elected_by_user_id: args.userId,
    }
  },
})

/** Clear the elected variant delegate — host falls back to the local ladder. */
export const clearVariantDelegate = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await variantDelegateRow(ctx)
    if (row) await ctx.db.delete(row._id)
    return null
  },
})
