/**
 * Model-pricing catalogue cache — Convex functions.
 *
 * The Convex half of the `ai_model_pricing` domain; the thin repository adapter
 * (`server/ai/pricing/store.ts`) marshals args into these and rebuilds the
 * `ModelCatalogue` map from the rows (docs/CONVEX-MIGRATION.md §2).
 *
 * The catalogue is small (tens of rows) and is replaced wholesale on each
 * refresh. The SQL `delete-all + loop-insert` transaction collapses into ONE
 * atomic mutation (§3 #13): collect every existing row, delete them, then insert
 * the new catalogue. `refreshed_at` (SQL column default) is stamped here. Every
 * function declares both `args` AND `returns` validators.
 *
 * @see server/ai/pricing/store.ts — the thin repository adapter
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

const nullableNumber = v.union(v.null(), v.number())

/** Shaped exactly like the repository's `PricingRow`. */
const pricingRowValidator = v.object({
  pricing_key: v.string(),
  input_per_mtok: v.number(),
  output_per_mtok: v.number(),
  cache_read_per_mtok: nullableNumber,
  cache_write_per_mtok: nullableNumber,
  context_window: nullableNumber,
})

/** Every cached pricing row (the repository folds these into a `ModelCatalogue`). */
export const list = query({
  args: {},
  returns: v.array(pricingRowValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query('ai_model_pricing').collect()
    return rows.map((r) => ({
      pricing_key: r.pricing_key,
      input_per_mtok: r.input_per_mtok,
      output_per_mtok: r.output_per_mtok,
      cache_read_per_mtok: r.cache_read_per_mtok,
      cache_write_per_mtok: r.cache_write_per_mtok,
      context_window: r.context_window,
    }))
  },
})

/**
 * Replace the cached catalogue wholesale in ONE atomic mutation (§3 #13):
 * delete every existing row, then insert the supplied entries.
 */
export const saveCatalogue = mutation({
  args: {
    entries: v.array(
      v.object({
        pricingKey: v.string(),
        inputPerMtok: v.number(),
        outputPerMtok: v.number(),
        cacheReadPerMtok: nullableNumber,
        cacheWritePerMtok: nullableNumber,
        contextWindow: nullableNumber,
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { entries }) => {
    const existing = await ctx.db.query('ai_model_pricing').collect()
    for (const row of existing) await ctx.db.delete(row._id)
    const refreshedAt = new Date().toISOString()
    for (const entry of entries) {
      await ctx.db.insert('ai_model_pricing', {
        pricing_key: entry.pricingKey,
        input_per_mtok: entry.inputPerMtok,
        output_per_mtok: entry.outputPerMtok,
        cache_read_per_mtok: entry.cacheReadPerMtok,
        cache_write_per_mtok: entry.cacheWritePerMtok,
        context_window: entry.contextWindow,
        refreshed_at: refreshedAt,
      })
    }
    return null
  },
})
