/**
 * Site shell singleton — Convex functions.
 *
 * The Convex half of the draft-site shell read/write. The thin repository
 * adapter (`server/repositories/site.ts`) marshals args into these and keeps
 * all the `@core/page-tree` shell (de)serialization + `validateSite` on the
 * Bun side — those helpers must not run in the Convex V8 runtime, exactly like
 * the `data_rows` hydration split (docs/CONVEX-MIGRATION.md §2, §4.6).
 *
 * Conventions:
 * - The site row is the `id = 'default'` singleton, looked up by `by_app_id`;
 *   Convex `_id` never leaks out.
 * - `settings_json` is stored as the opaque JSON string the SQLite `*_json`
 *   auto-stringify produced (§6). `getDraft` parses it back into the object the
 *   repository's `SiteRow.settings_json` shape expects; `saveDraft` stringifies.
 * - `saveDraft` is the SQL `insert … on conflict (id) do update` upsert
 *   re-expressed as read-by-index → patch-or-insert in ONE atomic mutation:
 *   on update only `name` / `settings_json` / `updated_at` change, `created_at`
 *   is preserved (mirrors the `excluded.*` column list).
 * - `created_at` / `updated_at` were SQL column defaults; stamped here on write.
 * - Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/site.ts — the thin adapter that calls these
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

/** The raw site row the repository's `readStoredShell` consumes (`SiteRow`). */
const siteRowValidator = v.object({
  id: v.string(),
  name: v.string(),
  settings_json: v.any(),
  created_at: v.string(),
  updated_at: v.string(),
})

/**
 * The singleton draft-site row (`id = 'default'`), or `null` when setup has not
 * yet created it. `settings_json` is parsed back into the stored payload object
 * the repository expects (it never re-parses a string).
 */
export const getDraft = query({
  args: {},
  returns: v.union(v.null(), siteRowValidator),
  handler: async (ctx) => {
    const row = await ctx.db
      .query('site')
      .withIndex('by_app_id', (q) => q.eq('id', 'default'))
      .unique()
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      settings_json: JSON.parse(row.settings_json) as unknown,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  },
})

/**
 * Upsert the singleton draft-site row. `settings` is the opaque stored payload
 * the repository assembled (`shellToStorage(shell)`); it is stringified into
 * `settings_json` here. On conflict only `name`, `settings_json`, and
 * `updated_at` change; `created_at` is preserved.
 */
export const saveDraft = mutation({
  args: { name: v.string(), settings: v.any() },
  returns: v.null(),
  handler: async (ctx, { name, settings }) => {
    const now = new Date().toISOString()
    const settingsJson = JSON.stringify(settings)
    const existing = await ctx.db
      .query('site')
      .withIndex('by_app_id', (q) => q.eq('id', 'default'))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, {
        name,
        settings_json: settingsJson,
        updated_at: now,
      })
    } else {
      await ctx.db.insert('site', {
        id: 'default',
        name,
        settings_json: settingsJson,
        created_at: now,
        updated_at: now,
      })
    }
    return null
  },
})
