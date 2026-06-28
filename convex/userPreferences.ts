/**
 * User preferences — Convex functions.
 *
 * The Convex half of the `user_preferences` domain; the thin repository adapter
 * (`server/repositories/userPreferences.ts`) marshals args into these and
 * returns their results unchanged. All real logic lives here: the
 * `(user_id, key)` lookup, the read-then-patch upsert (replaces SQL
 * `ON CONFLICT … DO UPDATE`, §4.6), `updated_at` generation (replaces the SQL
 * `current_timestamp` column write), and the JSON (de)serialisation of the
 * opaque `value_json` blob (§6: `*_json` columns are opaque `v.string()` and
 * are parsed/stringified here, never queried into).
 *
 * One row per `(user_id, key)`. `value_json` carries the JSON-serialised
 * preference payload; callers pass and receive the hydrated JS value, so this
 * module owns the `JSON.parse`/`JSON.stringify` boundary.
 *
 * Conventions (see docs/CONVEX-MIGRATION.md §2, §4):
 * - Every function declares `args` AND `returns` validators from convex/values.
 * - Reads return the hydrated preference value (or `null` when no row exists),
 *   matching the repository's `unknown | null` contract, so the repository is a
 *   pure pass-through.
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

/**
 * Read a single preference. Returns `null` when the row doesn't exist (the
 * user has never set this key — the common first-read case, not an error).
 * `value_json` is the opaque stored blob; it is parsed back to the hydrated JS
 * value here.
 */
export const get = query({
  args: { userId: v.string(), key: v.string() },
  returns: v.any(),
  handler: async (ctx, { userId, key }) => {
    const row = await ctx.db
      .query('user_preferences')
      .withIndex('by_user_key', (q) => q.eq('user_id', userId).eq('key', key))
      .unique()
    if (!row) return null
    return JSON.parse(row.value_json) as unknown
  },
})

/**
 * Upsert a preference. Read-by-index → patch-or-insert in one atomic mutation
 * (the Convex replacement for SQL `ON CONFLICT (user_id, key) DO UPDATE`).
 * `value` is serialised to the `value_json` blob; `updated_at` is set to the
 * current timestamp on every write — even a no-op overwrite — so "last touched"
 * stays accurate.
 */
export const upsert = mutation({
  args: { userId: v.string(), key: v.string(), value: v.any() },
  returns: v.null(),
  handler: async (ctx, { userId, key, value }) => {
    const valueJson = JSON.stringify(value)
    const updatedAt = new Date().toISOString()
    const existing = await ctx.db
      .query('user_preferences')
      .withIndex('by_user_key', (q) => q.eq('user_id', userId).eq('key', key))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { value_json: valueJson, updated_at: updatedAt })
    } else {
      await ctx.db.insert('user_preferences', {
        user_id: userId,
        key,
        value_json: valueJson,
        updated_at: updatedAt,
      })
    }
    return null
  },
})

/**
 * Delete a preference, resetting it to its default on the next read. Returns
 * `true` when a row was actually deleted, `false` when nothing was stored.
 */
export const del = mutation({
  args: { userId: v.string(), key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId, key }) => {
    const row = await ctx.db
      .query('user_preferences')
      .withIndex('by_user_key', (q) => q.eq('user_id', userId).eq('key', key))
      .unique()
    if (!row) return false
    await ctx.db.delete(row._id)
    return true
  },
})
