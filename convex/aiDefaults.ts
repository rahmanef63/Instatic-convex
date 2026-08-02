/**
 * Per-scope AI defaults — Convex functions.
 *
 * The Convex half of the `ai_defaults` domain; the thin repository adapter
 * (`server/ai/defaults/store.ts`) marshals args into these and maps results
 * back into the frozen `DefaultRecord` shape (docs/CONVEX-MIGRATION.md §2).
 *
 * `ai_defaults` is a per-scope singleton (one row per `site`/`content`/`data`/
 * `plugin`). The SQL `insert … on conflict (scope) do update` upsert becomes a
 * **read-by-index → patch-or-insert** inside one atomic mutation (§4.6).
 * `updated_at` (SQL column default) is stamped here. Every function declares
 * both `args` AND `returns` validators.
 *
 * @see server/ai/defaults/store.ts — the thin repository adapter
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

const scopeValidator = v.union(
  v.literal('site'),
  v.literal('content'),
  v.literal('data'),
  v.literal('plugin'),
)

/** Shaped exactly like the repository's `DefaultRow`. */
const defaultRowValidator = v.object({
  scope: scopeValidator,
  credential_id: v.string(),
  model_id: v.string(),
  updated_at: v.string(),
  updated_by: v.union(v.null(), v.string()),
})

/** All default rows (the SQL `select … from ai_defaults`). */
export const list = query({
  args: {},
  returns: v.array(defaultRowValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query('ai_defaults').collect()
    return rows.map((r) => ({
      scope: r.scope,
      credential_id: r.credential_id,
      model_id: r.model_id,
      updated_at: r.updated_at,
      updated_by: r.updated_by,
    }))
  },
})

/** Upsert the default for one scope (read-by-`by_scope` → patch-or-insert). */
export const setForScope = mutation({
  args: {
    scope: scopeValidator,
    credentialId: v.string(),
    modelId: v.string(),
    updatedBy: v.union(v.null(), v.string()),
  },
  returns: defaultRowValidator,
  handler: async (ctx, { scope, credentialId, modelId, updatedBy }) => {
    const now = new Date().toISOString()
    const existing = await ctx.db
      .query('ai_defaults')
      .withIndex('by_scope', (q) => q.eq('scope', scope))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, {
        credential_id: credentialId,
        model_id: modelId,
        updated_by: updatedBy,
        updated_at: now,
      })
    } else {
      await ctx.db.insert('ai_defaults', {
        scope,
        credential_id: credentialId,
        model_id: modelId,
        updated_by: updatedBy,
        updated_at: now,
      })
    }
    return {
      scope,
      credential_id: credentialId,
      model_id: modelId,
      updated_at: now,
      updated_by: updatedBy,
    }
  },
})

/** Delete the default for one scope (no-op when absent). */
export const clearForScope = mutation({
  args: { scope: scopeValidator },
  returns: v.null(),
  handler: async (ctx, { scope }) => {
    const existing = await ctx.db
      .query('ai_defaults')
      .withIndex('by_scope', (q) => q.eq('scope', scope))
      .unique()
    if (existing) await ctx.db.delete(existing._id)
    return null
  },
})
