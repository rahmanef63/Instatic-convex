/**
 * Site-bundle import — Convex functions.
 *
 * The three cross-domain `import.ts` handler transactions
 * (docs/CONVEX-MIGRATION.md §3 #4–#6) each collapse into ONE atomic mutation
 * here, doing every `ctx.db` write inline. Atomicity is the whole point: an
 * import spans `data_tables`, `data_rows`, `site`, `media_folders`, and
 * `data_row_redirects`, and a crash mid-loop must roll the entire bundle back
 * — so the work CANNOT be split across the per-domain Convex modules (each of
 * those is its own mutation, hence its own transaction). These mutations
 * deliberately re-implement the relevant slices of `convex/dataTables.ts`,
 * `convex/dataRows.ts`, `convex/dataPublish.ts`, `convex/mediaFolders.ts`, and
 * `convex/setup.ts` so they share one transaction.
 *
 *   replaceAll  (#4) — wipe all rows + all non-system tables + (when present)
 *                      folders/redirects, then reinsert tables / rows / site /
 *                      folders / redirects from the bundle.
 *   mergeAdd    (#5) — insert tables/rows that don't exist; never overwrite.
 *   mergeUpdate (#6) — upsert tables + rows; overwrite the site shell.
 *
 * Bundle parsing, capability checks, route/field normalisation, and the
 * parent-first folder ordering all stay Bun-side in the handler; it passes the
 * fully-prepared records in. Media bytes are written to the filesystem AFTER
 * these mutations (the handler), never inside.
 *
 * Conventions (docs/CONVEX-MIGRATION.md §2, §4.6, §6):
 * - Imports preserve the source `id`s; `*_json` blobs (`cells`, `settings`,
 *   `fields`) arrive prepared and are `JSON.stringify`d on write. User-ref
 *   columns are dropped on import (source ids won't exist locally).
 * - No `ON CONFLICT` → every upsert is a read-by-index → patch-or-insert.
 * - No partial-unique index → the live-slug guard on `data_tables` /
 *   `data_rows` is an explicit pre-write index read.
 * - Every function declares `args` AND `returns` validators.
 *
 * @see server/handlers/cms/import.ts — the handler that prepares + calls these
 */

import { v } from 'convex/values'
import { mutation, type MutationCtx } from './_generated/server'

// The four system table ids that are seeded and never deleted (mirror of the
// handler's `SYSTEM_TABLE_IDS`).
const SYSTEM_TABLE_IDS = new Set(['posts', 'pages', 'components', 'layouts'])

// ---------------------------------------------------------------------------
// Validators (the already-normalised wire shapes the handler prepares)
// ---------------------------------------------------------------------------

const kindValidator = v.union(
  v.literal('postType'),
  v.literal('data'),
  v.literal('page'),
  v.literal('component'),
  v.literal('layout'),
)

const statusValidator = v.union(
  v.literal('draft'),
  v.literal('published'),
  v.literal('unpublished'),
  v.literal('scheduled'),
)

const tableInputValidator = v.object({
  id: v.string(),
  name: v.string(),
  slug: v.string(),
  kind: kindValidator,
  routeBase: v.string(),
  singularLabel: v.string(),
  pluralLabel: v.string(),
  primaryFieldId: v.string(),
  fieldsJson: v.string(),
})

const rowInputValidator = v.object({
  id: v.string(),
  tableId: v.string(),
  cells: v.any(),
  slug: v.string(),
  status: statusValidator,
  publishedAt: v.union(v.null(), v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
})

const folderInputValidator = v.object({
  id: v.string(),
  parentId: v.union(v.null(), v.string()),
  name: v.string(),
  slug: v.string(),
  sortOrder: v.number(),
})

const redirectInputValidator = v.object({
  id: v.string(),
  tableId: v.string(),
  fromRouteBase: v.string(),
  fromSlug: v.string(),
  targetRowId: v.string(),
})

const siteInputValidator = v.object({ name: v.string(), settingsJson: v.string() })

// TS shapes mirroring the validators (helpers are typed against these).
type TableInput = {
  id: string
  name: string
  slug: string
  kind: 'postType' | 'data' | 'page' | 'component' | 'layout'
  routeBase: string
  singularLabel: string
  pluralLabel: string
  primaryFieldId: string
  fieldsJson: string
}
type RowInput = {
  id: string
  tableId: string
  cells: unknown
  slug: string
  status: 'draft' | 'published' | 'unpublished' | 'scheduled'
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}
type FolderInput = {
  id: string
  parentId: string | null
  name: string
  slug: string
  sortOrder: number
}
type RedirectInput = {
  id: string
  tableId: string
  fromRouteBase: string
  fromSlug: string
  targetRowId: string
}

// ---------------------------------------------------------------------------
// Lookup helpers (the app-id index reads §4.5)
// ---------------------------------------------------------------------------

function tableByAppId(ctx: MutationCtx, id: string) {
  return ctx.db.query('data_tables').withIndex('by_app_id', (q) => q.eq('id', id)).unique()
}

function rowByAppId(ctx: MutationCtx, id: string) {
  return ctx.db.query('data_rows').withIndex('by_app_id', (q) => q.eq('id', id)).unique()
}

// ---------------------------------------------------------------------------
// data_tables — create / insert-if-absent / field-update (§4.6 slug guard)
// ---------------------------------------------------------------------------

/**
 * Enforce the partial-unique slug index: reject a second LIVE table holding
 * `slug` (ignoring soft-deleted rows and, on update, the row itself).
 */
async function assertTableSlugFree(
  ctx: MutationCtx,
  slug: string,
  exceptId: string | null,
): Promise<void> {
  const matches = await ctx.db
    .query('data_tables')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .collect()
  if (matches.some((m) => m.deleted_at === null && m.id !== exceptId)) {
    throw new Error('A data table with this slug already exists')
  }
}

/** Raw insert of a prepared table record (`system` false, no user refs on import). */
async function rawInsertTable(ctx: MutationCtx, t: TableInput): Promise<void> {
  const now = new Date().toISOString()
  await ctx.db.insert('data_tables', {
    id: t.id,
    name: t.name,
    slug: t.slug,
    kind: t.kind,
    route_base: t.routeBase,
    singular_label: t.singularLabel,
    plural_label: t.pluralLabel,
    primary_field_id: t.primaryFieldId,
    fields_json: t.fieldsJson,
    system: false,
    created_by_user_id: null,
    updated_by_user_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  })
}

/** Insert a custom table, rejecting a duplicate live slug (mirror of dataTables.create). */
async function createTable(ctx: MutationCtx, t: TableInput): Promise<void> {
  await assertTableSlugFree(ctx, t.slug, null)
  await rawInsertTable(ctx, t)
}

/** Insert only when the id is absent (mirror of dataTables.insertIfAbsent). */
async function insertTableIfAbsent(ctx: MutationCtx, t: TableInput): Promise<boolean> {
  const existing = await tableByAppId(ctx, t.id)
  if (existing) return false
  await assertTableSlugFree(ctx, t.slug, null)
  await rawInsertTable(ctx, t)
  return true
}

/**
 * Update an existing live table's fields (mirror of dataTables.update over the
 * fields a bundle table carries — `kind` and the user refs are left untouched).
 */
async function updateTableFields(ctx: MutationCtx, t: TableInput): Promise<void> {
  const doc = await tableByAppId(ctx, t.id)
  if (!doc || doc.deleted_at !== null) return
  if (t.slug !== doc.slug) await assertTableSlugFree(ctx, t.slug, doc.id)
  await ctx.db.patch(doc._id, {
    name: t.name,
    slug: t.slug,
    route_base: t.routeBase,
    singular_label: t.singularLabel,
    plural_label: t.pluralLabel,
    primary_field_id: t.primaryFieldId,
    fields_json: t.fieldsJson,
    updated_at: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// data_rows — import insert / upsert / insert-if-absent (§4.6)
// ---------------------------------------------------------------------------

/** Full insert payload for an imported row (user refs dropped). */
function rowInsertDoc(input: RowInput) {
  return {
    id: input.id,
    table_id: input.tableId,
    cells_json: JSON.stringify(input.cells),
    slug: input.slug,
    status: input.status,
    active_version_id: null,
    author_user_id: null,
    created_by_user_id: null,
    updated_by_user_id: null,
    published_by_user_id: null,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    published_at: input.publishedAt,
    scheduled_publish_at: null,
    deleted_at: null,
    plugin_actor_id: null,
  } as const
}

/** Id-preserving upsert (mirror of dataRows.importUpsert). */
async function importUpsertRow(ctx: MutationCtx, input: RowInput): Promise<void> {
  const existing = await rowByAppId(ctx, input.id)
  if (existing) {
    await ctx.db.patch(existing._id, {
      table_id: input.tableId,
      cells_json: JSON.stringify(input.cells),
      slug: input.slug,
      status: input.status,
      published_at: input.publishedAt,
      updated_at: input.updatedAt,
    })
  } else {
    await ctx.db.insert('data_rows', rowInsertDoc(input))
  }
}

/**
 * Insert only when no constraint would be hit — skip if the id exists OR an
 * active row in the same table already owns the (non-empty) slug (mirror of
 * dataRows.importInsertIfAbsent).
 */
async function importInsertRowIfAbsent(ctx: MutationCtx, input: RowInput): Promise<boolean> {
  const existing = await rowByAppId(ctx, input.id)
  if (existing) return false
  if (input.slug) {
    const slugRows = await ctx.db
      .query('data_rows')
      .withIndex('by_table_slug', (q) => q.eq('table_id', input.tableId).eq('slug', input.slug))
      .collect()
    if (slugRows.some((r) => r.deleted_at === null)) return false
  }
  await ctx.db.insert('data_rows', rowInsertDoc(input))
  return true
}

// ---------------------------------------------------------------------------
// media_folders — wipe / import (§4.6)
// ---------------------------------------------------------------------------

/** Wipe every folder + every membership (mirror of mediaFolders.deleteAll). */
async function deleteAllFolders(ctx: MutationCtx): Promise<void> {
  const memberships = await ctx.db.query('media_asset_folders').collect()
  for (const m of memberships) await ctx.db.delete(m._id)
  const folders = await ctx.db.query('media_folders').collect()
  for (const f of folders) await ctx.db.delete(f._id)
}

/** Id-preserving folder upsert (mirror of mediaFolders.importFolder). */
async function importFolder(ctx: MutationCtx, f: FolderInput): Promise<void> {
  const existing = await ctx.db
    .query('media_folders')
    .withIndex('by_app_id', (q) => q.eq('id', f.id))
    .unique()
  if (existing) {
    await ctx.db.patch(existing._id, {
      parent_id: f.parentId,
      name: f.name,
      slug: f.slug,
      sort_order: f.sortOrder,
    })
  } else {
    await ctx.db.insert('media_folders', {
      id: f.id,
      parent_id: f.parentId,
      name: f.name,
      slug: f.slug,
      sort_order: f.sortOrder,
      created_by_user_id: null,
      created_at: new Date().toISOString(),
    })
  }
}

// ---------------------------------------------------------------------------
// data_row_redirects — wipe / import (§4.6)
// ---------------------------------------------------------------------------

/** Wipe all redirects (mirror of dataPublish.deleteAllRedirects). */
async function deleteAllRedirects(ctx: MutationCtx): Promise<void> {
  const redirects = await ctx.db.query('data_row_redirects').collect()
  for (const redirect of redirects) await ctx.db.delete(redirect._id)
}

/** Id-preserving redirect upsert on the `(from_route_base, from_slug)` source key. */
async function importRedirect(ctx: MutationCtx, r: RedirectInput): Promise<void> {
  const existing = await ctx.db
    .query('data_row_redirects')
    .withIndex('by_source', (q) =>
      q.eq('from_route_base', r.fromRouteBase).eq('from_slug', r.fromSlug),
    )
    .first()
  if (existing) {
    await ctx.db.patch(existing._id, {
      table_id: r.tableId,
      target_row_id: r.targetRowId,
    })
  } else {
    await ctx.db.insert('data_row_redirects', {
      id: r.id,
      table_id: r.tableId,
      from_route_base: r.fromRouteBase,
      from_slug: r.fromSlug,
      target_row_id: r.targetRowId,
      created_at: new Date().toISOString(),
    })
  }
}

// ---------------------------------------------------------------------------
// site — singleton upsert (§4.6)
// ---------------------------------------------------------------------------

/** Upsert the `id = 'default'` site row (mirror of convex/setup.ts createSite). */
async function upsertSite(ctx: MutationCtx, name: string, settingsJson: string): Promise<void> {
  const existing = await ctx.db
    .query('site')
    .withIndex('by_app_id', (q) => q.eq('id', 'default'))
    .unique()
  const now = new Date().toISOString()
  if (existing) {
    await ctx.db.patch(existing._id, { name, settings_json: settingsJson, updated_at: now })
  } else {
    await ctx.db.insert('site', {
      id: 'default',
      name,
      settings_json: settingsJson,
      created_at: now,
      updated_at: now,
    })
  }
}

// ---------------------------------------------------------------------------
// Strategy mutations — each is one atomic transaction
// ---------------------------------------------------------------------------

/**
 * `replace` strategy (§3 #4): wipe-and-reload. Delete every data row and every
 * non-system table, then upsert system tables / create custom tables, plain
 * insert all rows, replace the site shell, and (when present) wipe + reinsert
 * the folder tree and redirects. **Largest mutation in the system** — bounded
 * by total row + table count (§4.7); a multi-thousand-row bundle is the
 * documented chunking risk.
 */
export const replaceAll = mutation({
  args: {
    tables: v.array(tableInputValidator),
    rows: v.array(rowInputValidator),
    site: v.optional(siteInputValidator),
    mediaFolders: v.optional(v.array(folderInputValidator)),
    redirects: v.optional(v.array(redirectInputValidator)),
  },
  returns: v.object({
    tablesAffected: v.number(),
    rowsInserted: v.number(),
    mediaFoldersImported: v.number(),
    redirectsImported: v.number(),
  }),
  handler: async (ctx, args) => {
    let tablesAffected = 0
    let rowsInserted = 0
    let mediaFoldersImported = 0
    let redirectsImported = 0

    // 1. Delete ALL data rows (covers every table).
    const allRows = await ctx.db.query('data_rows').collect()
    for (const r of allRows) await ctx.db.delete(r._id)

    // 2. Delete all non-system data tables.
    const allTables = await ctx.db.query('data_tables').collect()
    for (const t of allTables) if (t.system === false) await ctx.db.delete(t._id)

    // 3. Remaining (system) table ids drive update-vs-insert.
    const remaining = await ctx.db.query('data_tables').collect()
    const existingTableIds = new Set(
      remaining.filter((t) => t.deleted_at === null).map((t) => t.id),
    )

    // 4. Upsert tables from the bundle.
    for (const table of args.tables) {
      if (existingTableIds.has(table.id)) {
        await updateTableFields(ctx, table)
        tablesAffected++
      } else if (!SYSTEM_TABLE_IDS.has(table.id)) {
        await createTable(ctx, table)
        tablesAffected++
      }
      // A bundle table whose id is a known SYSTEM_TABLE_ID but wasn't seeded
      // locally is silently skipped — it should never occur in practice.
    }

    // 5. Plain-insert all rows (the table was just wiped).
    for (const row of args.rows) {
      await ctx.db.insert('data_rows', rowInsertDoc(row))
      rowsInserted++
    }

    // 6. Replace the site shell.
    if (args.site) await upsertSite(ctx, args.site.name, args.site.settingsJson)

    // 7. Media folder tree (handler already ordered parent-first).
    if (args.mediaFolders) {
      await deleteAllFolders(ctx)
      for (const folder of args.mediaFolders) {
        await importFolder(ctx, folder)
        mediaFoldersImported++
      }
    }

    // 8. Redirects (reinsert once the target rows exist).
    if (args.redirects) {
      await deleteAllRedirects(ctx)
      for (const redirect of args.redirects) {
        await importRedirect(ctx, redirect)
        redirectsImported++
      }
    }

    return { tablesAffected, rowsInserted, mediaFoldersImported, redirectsImported }
  },
})

/**
 * `merge-add` strategy (§3 #5): add only what's missing. Insert each table /
 * row whose id is absent; skip existing ones. Never overwrites content and
 * never touches the site shell, folders, or redirects.
 */
export const mergeAdd = mutation({
  args: {
    tables: v.array(tableInputValidator),
    rows: v.array(rowInputValidator),
  },
  returns: v.object({
    tablesAffected: v.number(),
    rowsInserted: v.number(),
    rowsSkipped: v.number(),
  }),
  handler: async (ctx, args) => {
    let tablesAffected = 0
    let rowsInserted = 0
    let rowsSkipped = 0

    for (const table of args.tables) {
      if (await insertTableIfAbsent(ctx, table)) tablesAffected++
    }
    for (const row of args.rows) {
      if (await importInsertRowIfAbsent(ctx, row)) rowsInserted++
      else rowsSkipped++
    }

    return { tablesAffected, rowsInserted, rowsSkipped }
  },
})

/**
 * `merge-overwrite` strategy (§3 #6): upsert tables + rows with bundle values,
 * and overwrite the site shell when present. Row classification (inserted vs
 * replaced) uses the set of live row ids pre-fetched before any write.
 */
export const mergeUpdate = mutation({
  args: {
    tables: v.array(tableInputValidator),
    rows: v.array(rowInputValidator),
    site: v.optional(siteInputValidator),
  },
  returns: v.object({
    tablesAffected: v.number(),
    rowsInserted: v.number(),
    rowsReplaced: v.number(),
  }),
  handler: async (ctx, args) => {
    let tablesAffected = 0
    let rowsInserted = 0
    let rowsReplaced = 0

    // Pre-fetch all existing live row ids for the bundle's tables so each row
    // can be classified inserted-vs-replaced without per-row SELECTs.
    const existingRowIds = new Set<string>()
    for (const table of args.tables) {
      const rows = await ctx.db
        .query('data_rows')
        .withIndex('by_table_updated', (q) => q.eq('table_id', table.id))
        .collect()
      for (const r of rows) if (r.deleted_at === null) existingRowIds.add(r.id)
    }

    // Tables: insert if absent, update if already present.
    for (const table of args.tables) {
      const inserted = await insertTableIfAbsent(ctx, table)
      if (!inserted) await updateTableFields(ctx, table)
      tablesAffected++
    }

    // Rows: upsert all; classify via the pre-fetched set.
    for (const row of args.rows) {
      await importUpsertRow(ctx, row)
      if (existingRowIds.has(row.id)) rowsReplaced++
      else rowsInserted++
    }

    // Site shell: overwrite when the bundle carries one.
    if (args.site) await upsertSite(ctx, args.site.name, args.site.settingsJson)

    return { tablesAffected, rowsInserted, rowsReplaced }
  },
})
