/**
 * Plugins — Convex functions for `installed_plugins`, `plugin_records`
 * (the per-plugin KV/resource store), and `plugin_crash_events`.
 *
 * The Convex half of the `plugins` domain; the thin repository adapter
 * (`server/repositories/plugins.ts`) marshals args into these and maps the
 * results back into the frozen `InstalledPluginResult` / `PluginRecord` shapes
 * (docs/CONVEX-MIGRATION.md §2). The split mirrors the proven `users` /
 * `dataRows` slices:
 *
 * - **Mapping stays in the repository.** Every read here returns the raw row
 *   columns — `*_json` blobs stay opaque `v.string()` at rest (§6); the
 *   repository's `readManifestJson` / `mapInstalledPlugin` / `mapPluginRecord`
 *   parse + shape them. This keeps `@core/plugins` manifest validation and the
 *   settings/secret merge out of the Convex V8 runtime.
 * - **No `ON CONFLICT`.** `install` is a read-by-`by_app_id` → patch-or-insert
 *   upsert (§4.6), replicating the SQL `on conflict (id) do update` branch
 *   exactly (settings_json is preserved on the update path, as the SQL left it
 *   untouched).
 * - **No `json_extract`.** `listRecords` fetches a plugin/resource's rows by the
 *   `by_resource` index, parses `data_json`, and applies the
 *   eq/ne/gt/gte/lt/lte/in/like operator-DSL + order-by in JS (§4.2), then
 *   pages in JS — the same fallback `dataRows.listWithFilter` uses.
 * - **No cascade delete.** SQL `delete from installed_plugins` relied on the
 *   `on delete cascade` FKs of `plugin_secrets` / `plugin_schedules` /
 *   `plugin_crash_events`. Convex has no cascade (§intro), so `deletePlugin`
 *   deletes those children explicitly in the same atomic mutation
 *   (docs/CONVEX-MIGRATION.md §3 #19). `plugin_schedule_runs` has no FK — the
 *   handler clears it separately via `clearPluginScheduleRuns`, unchanged.
 *
 * Transactions collapsed to single atomic mutations (§3 #19):
 * `install` (installed_plugins upsert), `setSettings` (settings_json write —
 * the encrypted secret split runs Bun-side around it), `recordCrash` (insert +
 * rolling-window prune), `deletePlugin` (row + cascade children).
 *
 * App identity is the app-generated nanoid `id` (records carry their own; the
 * plugin id is the manifest id). `created_at` / `updated_at` / `installed_at` /
 * `occurred_at` (SQL column defaults) are stamped here. Convex `_id` never
 * leaks out. Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/plugins.ts — the thin repository adapter
 */

import { v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const nullableString = v.union(v.null(), v.string())

const lifecycleValidator = v.union(
  v.literal('installed'),
  v.literal('active'),
  v.literal('disabled'),
  v.literal('error'),
)

/**
 * The raw `installed_plugins` row the repository's `mapInstalledPlugin`
 * consumes. `*_json` columns travel as opaque strings (parsed in the repo via
 * `readManifestJson`).
 */
const installedPluginRowValidator = v.object({
  id: v.string(),
  name: v.string(),
  version: v.string(),
  enabled: v.boolean(),
  lifecycle_status: lifecycleValidator,
  last_error: nullableString,
  granted_permissions_json: v.string(),
  manifest_json: v.string(),
  settings_json: v.string(),
  installed_at: v.string(),
  updated_at: v.string(),
})

/** The raw `plugin_records` row the repository's `mapPluginRecord` consumes. */
const pluginRecordRowValidator = v.object({
  id: v.string(),
  plugin_id: v.string(),
  resource_id: v.string(),
  data_json: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
})

/** The raw `plugin_crash_events` row the repository's `mapPluginCrashEvent` consumes. */
const crashEventRowValidator = v.object({
  id: v.string(),
  plugin_id: v.string(),
  occurred_at: v.string(),
  reason: v.string(),
  stack: nullableString,
})

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function pluginByAppId(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db
    .query('installed_plugins')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

function recordByAppId(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db
    .query('plugin_records')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

function toInstalledRow(row: Doc<'installed_plugins'>) {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    enabled: row.enabled,
    lifecycle_status: row.lifecycle_status,
    last_error: row.last_error,
    granted_permissions_json: row.granted_permissions_json,
    manifest_json: row.manifest_json,
    settings_json: row.settings_json,
    installed_at: row.installed_at,
    updated_at: row.updated_at,
  }
}

function toRecordRow(row: Doc<'plugin_records'>) {
  return {
    id: row.id,
    plugin_id: row.plugin_id,
    resource_id: row.resource_id,
    data_json: row.data_json,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toCrashRow(row: Doc<'plugin_crash_events'>) {
  return {
    id: row.id,
    plugin_id: row.plugin_id,
    occurred_at: row.occurred_at,
    reason: row.reason,
    stack: row.stack,
  }
}

// ---------------------------------------------------------------------------
// installed_plugins — reads
// ---------------------------------------------------------------------------

/** Every installed plugin, newest install first (the SQL `order by installed_at desc`). */
export const listInstalled = query({
  args: {},
  returns: v.array(installedPluginRowValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query('installed_plugins').collect()
    rows.sort((a, b) =>
      a.installed_at < b.installed_at ? 1 : a.installed_at > b.installed_at ? -1 : 0,
    )
    return rows.map(toInstalledRow)
  },
})

/** One installed plugin by id, or `null`. */
export const getInstalled = query({
  args: { id: v.string() },
  returns: v.union(v.null(), installedPluginRowValidator),
  handler: async (ctx, { id }) => {
    const row = await pluginByAppId(ctx, id)
    return row ? toInstalledRow(row) : null
  },
})

// ---------------------------------------------------------------------------
// installed_plugins — writes
// ---------------------------------------------------------------------------

/**
 * Upsert an installed plugin by id (the SQL `on conflict (id) do update`, §4.6).
 * On insert the row starts `enabled`, `lifecycle_status='installed'`,
 * `last_error=null`. On the update path name/version/manifest/granted-perms are
 * overwritten and the plugin is re-enabled + reset to `installed`, but
 * `settings_json` is preserved untouched (matching the SQL, which never listed
 * it in the `do update set`). Always returns the resulting row.
 */
export const install = mutation({
  args: {
    id: v.string(),
    name: v.string(),
    version: v.string(),
    manifestJson: v.string(),
    grantedPermissionsJson: v.string(),
    settingsJson: v.string(),
  },
  returns: installedPluginRowValidator,
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const existing = await pluginByAppId(ctx, args.id)
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        version: args.version,
        manifest_json: args.manifestJson,
        granted_permissions_json: args.grantedPermissionsJson,
        enabled: true,
        lifecycle_status: 'installed',
        last_error: null,
        updated_at: now,
      })
      const fresh = await ctx.db.get(existing._id)
      return toInstalledRow(fresh!)
    }
    const docId = await ctx.db.insert('installed_plugins', {
      id: args.id,
      name: args.name,
      version: args.version,
      enabled: true,
      granted_permissions_json: args.grantedPermissionsJson,
      manifest_json: args.manifestJson,
      lifecycle_status: 'installed',
      last_error: null,
      settings_json: args.settingsJson,
      installed_at: now,
      updated_at: now,
    })
    const fresh = await ctx.db.get(docId)
    return toInstalledRow(fresh!)
  },
})

/** Toggle a plugin's `enabled` flag; returns the row, or `null` if missing. */
export const setEnabled = mutation({
  args: { id: v.string(), enabled: v.boolean() },
  returns: v.union(v.null(), installedPluginRowValidator),
  handler: async (ctx, { id, enabled }) => {
    const row = await pluginByAppId(ctx, id)
    if (!row) return null
    await ctx.db.patch(row._id, { enabled, updated_at: new Date().toISOString() })
    const fresh = await ctx.db.get(row._id)
    return toInstalledRow(fresh!)
  },
})

/** Set a plugin's lifecycle status + optional last error; returns the row, or `null`. */
export const setLifecycleStatus = mutation({
  args: {
    id: v.string(),
    lifecycleStatus: lifecycleValidator,
    lastError: nullableString,
  },
  returns: v.union(v.null(), installedPluginRowValidator),
  handler: async (ctx, { id, lifecycleStatus, lastError }) => {
    const row = await pluginByAppId(ctx, id)
    if (!row) return null
    await ctx.db.patch(row._id, {
      lifecycle_status: lifecycleStatus,
      last_error: lastError,
      updated_at: new Date().toISOString(),
    })
    const fresh = await ctx.db.get(row._id)
    return toInstalledRow(fresh!)
  },
})

/**
 * Persist the non-secret `settings_json` (the secret split is applied Bun-side
 * before this call). Returns the row, or `null` if the plugin is missing.
 */
export const setSettings = mutation({
  args: { id: v.string(), settingsJson: v.string() },
  returns: v.union(v.null(), installedPluginRowValidator),
  handler: async (ctx, { id, settingsJson }) => {
    const row = await pluginByAppId(ctx, id)
    if (!row) return null
    await ctx.db.patch(row._id, {
      settings_json: settingsJson,
      updated_at: new Date().toISOString(),
    })
    const fresh = await ctx.db.get(row._id)
    return toInstalledRow(fresh!)
  },
})

/**
 * Delete an installed plugin and every row that referenced it via an
 * `on delete cascade` FK — `plugin_secrets`, `plugin_schedules`, and
 * `plugin_crash_events` — explicitly, in one atomic mutation (Convex has no
 * cascade, §3 #19). `plugin_schedule_runs` carries no FK and is cleared by the
 * handler separately. Returns `true` only when the plugin row existed.
 */
export const deletePlugin = mutation({
  args: { id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id }) => {
    const row = await pluginByAppId(ctx, id)
    if (!row) return false

    const secrets = await ctx.db
      .query('plugin_secrets')
      .withIndex('by_plugin', (q) => q.eq('plugin_id', id))
      .collect()
    for (const secret of secrets) await ctx.db.delete(secret._id)

    const schedules = await ctx.db
      .query('plugin_schedules')
      .withIndex('by_plugin', (q) => q.eq('plugin_id', id))
      .collect()
    for (const schedule of schedules) await ctx.db.delete(schedule._id)

    const crashes = await ctx.db
      .query('plugin_crash_events')
      .withIndex('by_plugin_occurred', (q) => q.eq('plugin_id', id))
      .collect()
    for (const crash of crashes) await ctx.db.delete(crash._id)

    await ctx.db.delete(row._id)
    return true
  },
})

// ---------------------------------------------------------------------------
// plugin_records — operator-DSL list (§4.2 — candidates by index, filter in JS)
// ---------------------------------------------------------------------------

/** SQL `LIKE` semantics over a string value (`%` → any run, `_` → any char), case-insensitive. */
function likeMatch(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false
  const escaped = pattern
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.')
  return new RegExp(`^${escaped}$`).test(value.toLowerCase())
}

/** Total order over heterogeneous JSON values (null-low; numeric vs lexical). */
function compareUnknown(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function matchesFilter(data: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const fieldVal = data[key]
    if (value === null || typeof value !== 'object') {
      // Shorthand primitive — treated as eq.
      if (fieldVal !== value) return false
      continue
    }
    const op = value as Record<string, unknown>
    if ('eq' in op && fieldVal !== op.eq) return false
    if ('ne' in op && fieldVal === op.ne) return false
    if ('gt' in op && !(compareUnknown(fieldVal, op.gt) > 0)) return false
    if ('gte' in op && !(compareUnknown(fieldVal, op.gte) >= 0)) return false
    if ('lt' in op && !(compareUnknown(fieldVal, op.lt) < 0)) return false
    if ('lte' in op && !(compareUnknown(fieldVal, op.lte) <= 0)) return false
    if ('in' in op) {
      const list = op.in as unknown[]
      if (list.length === 0) return false
      if (!list.includes(fieldVal)) return false
    }
    if ('like' in op && !likeMatch(fieldVal, String(op.like))) return false
  }
  return true
}

/**
 * List a plugin/resource's records with the storage operator-DSL filter,
 * ordering, and paging — all applied in JS over the parsed `data_json`. The
 * default order is `created_at desc` (the SQL default); a custom `orderBy`
 * targets `data_json` fields (matching the SQL `json_extract(data_json, key)`).
 */
export const listRecords = query({
  args: {
    pluginId: v.string(),
    resourceId: v.string(),
    filter: v.optional(v.any()),
    orderBy: v.optional(v.any()),
    limit: v.number(),
    offset: v.number(),
  },
  returns: v.object({
    records: v.array(pluginRecordRowValidator),
    totalCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const filter = (args.filter ?? undefined) as Record<string, unknown> | undefined
    const orderBy = (args.orderBy ?? undefined) as Record<string, 'asc' | 'desc'> | undefined
    const limit = Math.max(1, args.limit)
    const offset = Math.max(0, args.offset)

    const all = await ctx.db
      .query('plugin_records')
      .withIndex('by_resource', (q) =>
        q.eq('plugin_id', args.pluginId).eq('resource_id', args.resourceId),
      )
      .collect()

    const parsed = all.map((row) => ({
      row,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
    }))

    const matched = filter
      ? parsed.filter(({ data }) => matchesFilter(data, filter))
      : parsed

    if (orderBy && Object.keys(orderBy).length > 0) {
      const orderEntries = Object.entries(orderBy)
      matched.sort((a, b) => {
        for (const [key, dir] of orderEntries) {
          const cmp = compareUnknown(a.data[key], b.data[key])
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
        }
        return 0
      })
    } else {
      // SQL default: created_at desc.
      matched.sort((a, b) =>
        a.row.created_at < b.row.created_at ? 1 : a.row.created_at > b.row.created_at ? -1 : 0,
      )
    }

    const totalCount = matched.length
    const page = matched.slice(offset, offset + limit)
    return { records: page.map(({ row }) => toRecordRow(row)), totalCount }
  },
})

// ---------------------------------------------------------------------------
// plugin_records — writes
// ---------------------------------------------------------------------------

/** Insert a new record (id supplied by the caller); returns the raw row. */
export const createRecord = mutation({
  args: {
    id: v.string(),
    pluginId: v.string(),
    resourceId: v.string(),
    dataJson: v.string(),
  },
  returns: pluginRecordRowValidator,
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('plugin_records', {
      id: args.id,
      plugin_id: args.pluginId,
      resource_id: args.resourceId,
      data_json: args.dataJson,
      created_at: now,
      updated_at: now,
    })
    const fresh = await ctx.db.get(docId)
    return toRecordRow(fresh!)
  },
})

/**
 * Update a record's `data_json`, guarded by the same (id, plugin_id,
 * resource_id) triple the SQL `WHERE` used. Returns the row, or `null` if no
 * such record.
 */
export const updateRecord = mutation({
  args: {
    id: v.string(),
    pluginId: v.string(),
    resourceId: v.string(),
    dataJson: v.string(),
  },
  returns: v.union(v.null(), pluginRecordRowValidator),
  handler: async (ctx, args) => {
    const row = await recordByAppId(ctx, args.id)
    if (!row || row.plugin_id !== args.pluginId || row.resource_id !== args.resourceId) {
      return null
    }
    await ctx.db.patch(row._id, {
      data_json: args.dataJson,
      updated_at: new Date().toISOString(),
    })
    const fresh = await ctx.db.get(row._id)
    return toRecordRow(fresh!)
  },
})

/** Delete a record, guarded by (id, plugin_id, resource_id). Returns `true` if deleted. */
export const deleteRecord = mutation({
  args: { id: v.string(), pluginId: v.string(), resourceId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id, pluginId, resourceId }) => {
    const row = await recordByAppId(ctx, id)
    if (!row || row.plugin_id !== pluginId || row.resource_id !== resourceId) return false
    await ctx.db.delete(row._id)
    return true
  },
})

// ---------------------------------------------------------------------------
// plugin_crash_events — rolling-window history
// ---------------------------------------------------------------------------

/**
 * Insert a crash event then prune the plugin's history to the `keep` most
 * recent (the SQL insert + delete-not-in-latest-N rolling window), in one
 * atomic mutation. Returns the inserted row.
 */
export const recordCrash = mutation({
  args: {
    id: v.string(),
    pluginId: v.string(),
    reason: v.string(),
    stack: nullableString,
    keep: v.number(),
  },
  returns: crashEventRowValidator,
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('plugin_crash_events', {
      id: args.id,
      plugin_id: args.pluginId,
      occurred_at: now,
      reason: args.reason,
      stack: args.stack,
    })

    // Roll the window — keep only the `keep` most recent events for this plugin.
    const events = await ctx.db
      .query('plugin_crash_events')
      .withIndex('by_plugin_occurred', (q) => q.eq('plugin_id', args.pluginId))
      .collect()
    events.sort((a, b) =>
      a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0,
    )
    for (const stale of events.slice(args.keep)) await ctx.db.delete(stale._id)

    const fresh = await ctx.db.get(docId)
    return toCrashRow(fresh!)
  },
})

/** The most-recent crash events for one plugin, newest first. */
export const listCrashes = query({
  args: { pluginId: v.string(), limit: v.number() },
  returns: v.array(crashEventRowValidator),
  handler: async (ctx, { pluginId, limit }) => {
    const events = await ctx.db
      .query('plugin_crash_events')
      .withIndex('by_plugin_occurred', (q) => q.eq('plugin_id', pluginId))
      .collect()
    events.sort((a, b) =>
      a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0,
    )
    return events.slice(0, limit).map(toCrashRow)
  },
})

/** Drop every crash event for a plugin (uninstall + manual restart paths). */
export const clearCrashes = mutation({
  args: { pluginId: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId }) => {
    const events = await ctx.db
      .query('plugin_crash_events')
      .withIndex('by_plugin_occurred', (q) => q.eq('plugin_id', pluginId))
      .collect()
    for (const event of events) await ctx.db.delete(event._id)
    return null
  },
})
