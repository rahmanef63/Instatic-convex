/**
 * Setup / first-run wizard — Convex functions.
 *
 * The Convex half of the `setup` domain; the thin repository adapter
 * (`server/repositories/setup.ts`) marshals args into these and returns their
 * results unchanged. The repository keeps the in-process `getSetupStatusCached`
 * memo (a hot-path optimisation over the live status read) — that cache stays
 * in the repository because it is keyed by the server-process client handle and
 * has no place in the database.
 *
 * Conventions (see docs/CONVEX-MIGRATION.md §2, §4.6):
 * - The `site` row is the `id = 'default'` singleton; `createSite` is the
 *   `ON CONFLICT (id) DO UPDATE` upsert re-expressed as read-by-index →
 *   patch-or-insert inside one atomic mutation.
 * - `created_at` / `updated_at` were SQL column defaults; they are generated
 *   here on write. Convex `_id` never leaks out.
 * - Every function declares both `args` AND `returns` validators.
 */

import { v } from 'convex/values'
import { mutation, query } from './_generated/server'

/** The camelCase shape the repository exposes as `SetupStatus`. */
const setupStatusValidator = v.object({
  hasSite: v.boolean(),
  hasAdmin: v.boolean(),
  hasOwner: v.boolean(),
  needsSetup: v.boolean(),
})

/**
 * Whether the install has a site and at least one active, non-deleted owner.
 *
 * Replaces the two SQL `COUNT(*)` reads. The owner branch fetches the `owner`
 * role slice by index, then applies the `status = 'active' AND deleted_at IS
 * NULL` predicate in JS (the SQL partial filter has no Convex equivalent).
 */
export const getStatus = query({
  args: {},
  returns: setupStatusValidator,
  handler: async (ctx) => {
    const site = await ctx.db.query('site').take(1)
    const hasSite = site.length > 0

    const owners = await ctx.db
      .query('users')
      .withIndex('by_role_id', (q) => q.eq('role_id', 'owner'))
      .collect()
    const hasOwner = owners.some(
      (u) => u.status === 'active' && u.deleted_at === null,
    )

    return {
      hasSite,
      hasAdmin: hasOwner,
      hasOwner,
      needsSetup: !hasSite || !hasOwner,
    }
  },
})

/**
 * Upsert the singleton site row (app id `'default'`).
 *
 * `settings` is stored as the opaque `settings_json` blob (stringified here,
 * mirroring the old SQLite `*_json` auto-stringify). On conflict only `name`,
 * `settings_json`, and `updated_at` change; `created_at` is preserved.
 */
export const createSite = mutation({
  args: {
    name: v.string(),
    settings: v.any(),
  },
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
