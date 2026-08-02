/**
 * Data tables (`data_tables`) CRUD + version-number allocation — Convex functions.
 *
 * The Convex half of the data-tables domain; the thin repository adapter
 * (`server/repositories/data/tables.ts`) marshals args into these and maps the
 * returned wire rows into the `DataTable` / `DataTableListItem` domain shapes via
 * its `mapTable` helper. The split (docs/CONVEX-MIGRATION.md §2):
 *
 * - **Reads return a raw wire row**, not the camelCase `DataTable`. The
 *   route-base + field normalisation (`normalizeRouteBase`,
 *   `normalizeDataTableFields`) lives in `@core`, which we deliberately keep out
 *   of the Convex V8 runtime (same convention as `convex/users.ts`). So the
 *   repository owns `mapTable`; here we just project the document columns,
 *   leaving `fields_json` an opaque string the repository parses (§4.2/§6).
 * - **Identity is the app nanoid `id`**, generated here on insert when absent
 *   (mirrors the old `${nanoid()}` default). `created_at` / `updated_at` replace
 *   the SQL `current_timestamp` defaults and are stamped here. Convex `_id`
 *   never leaks out.
 * - **The partial-unique `data_tables_slug_active_idx WHERE deleted_at IS NULL`
 *   has no Convex equivalent** (§4.6): it is enforced by an explicit pre-write
 *   read of the `by_slug` index inside every insert/slug-changing update
 *   (`assertSlugFree`).
 * - **`softDelete` collapses the old three-statement read→count→update sequence
 *   into ONE atomic mutation** (§3): the system-table guard and the
 *   "no live rows" guard (which was a separate `countDataRows` call) both run
 *   inside the handler, so no interleaving write can slip a row in between the
 *   check and the delete.
 * - Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/data/tables.ts    — the thin repository adapter
 * @see server/repositories/data/versions.ts  — adapter for `nextVersionNumber`
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import type { WithoutSystemFields } from 'convex/server'
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server'
import type { Doc } from './_generated/dataModel'

const kindValidator = v.union(
  v.literal('postType'),
  v.literal('data'),
  v.literal('page'),
  v.literal('component'),
  v.literal('layout'),
)

/**
 * The raw wire row the repository's `mapTable` consumes. `fields_json` is the
 * opaque JSON blob (parsed in the repository); `system` is the concrete boolean;
 * dates are ISO strings. Defined once and reused (plain + with-count variants).
 */
const tableRowFields = {
  id: v.string(),
  name: v.string(),
  slug: v.string(),
  kind: kindValidator,
  route_base: v.string(),
  singular_label: v.string(),
  plural_label: v.string(),
  primary_field_id: v.string(),
  fields_json: v.string(),
  system: v.boolean(),
  created_by_user_id: v.union(v.null(), v.string()),
  updated_by_user_id: v.union(v.null(), v.string()),
  created_at: v.string(),
  updated_at: v.string(),
}
const tableRowValidator = v.object(tableRowFields)
const tableRowWithCountValidator = v.object({
  ...tableRowFields,
  row_count: v.number(),
})

function toRow(doc: Doc<'data_tables'>) {
  return {
    id: doc.id,
    name: doc.name,
    slug: doc.slug,
    kind: doc.kind,
    route_base: doc.route_base,
    singular_label: doc.singular_label,
    plural_label: doc.plural_label,
    primary_field_id: doc.primary_field_id,
    fields_json: doc.fields_json,
    system: doc.system,
    created_by_user_id: doc.created_by_user_id,
    updated_by_user_id: doc.updated_by_user_id,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  }
}

/** Look a table up by its app-generated nanoid id (the `by_app_id` index). */
function tableByAppId(ctx: QueryCtx, id: string) {
  return ctx.db
    .query('data_tables')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

/**
 * Fixed display order: system kinds first (page, postType, component, layout),
 * then everything else; ties broken by `created_at asc`. This is the SQL
 * `order by case kind … , created_at asc` re-expressed in JS.
 */
const KIND_RANK: Record<string, number> = {
  page: 0,
  postType: 1,
  component: 2,
  layout: 3,
}
function kindRank(kind: string): number {
  return KIND_RANK[kind] ?? 4
}
function compareTables(a: Doc<'data_tables'>, b: Doc<'data_tables'>): number {
  const ra = kindRank(a.kind)
  const rb = kindRank(b.kind)
  if (ra !== rb) return ra - rb
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}

/** Count non-deleted rows in a table (the SQL `count(*) … deleted_at is null`). */
async function countLiveRows(ctx: QueryCtx, tableId: string): Promise<number> {
  const rows = await ctx.db
    .query('data_rows')
    .withIndex('by_table_updated', (q) => q.eq('table_id', tableId))
    .collect()
  return rows.filter((r) => r.deleted_at === null).length
}

/**
 * Enforce the partial-unique slug index: reject a second LIVE table holding
 * `slug` (ignoring soft-deleted rows and, on update, the row itself). Replaces
 * the SQL `data_tables_slug_active_idx` constraint (§4.6).
 */
async function assertSlugFree(
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every non-deleted table, system kinds first then `created_at asc`. */
export const list = query({
  args: {},
  returns: v.array(tableRowValidator),
  handler: async (ctx) => {
    const all = await ctx.db.query('data_tables').collect()
    const live = all.filter((t) => t.deleted_at === null).sort(compareTables)
    return live.map(toRow)
  },
})

/**
 * Like `list`, but enriches each table with its current non-deleted row count
 * (the SQL correlated subselect). One `by_table_updated` scan per table — fine
 * given the tiny number of tables.
 */
export const listWithCounts = query({
  args: {},
  returns: v.array(tableRowWithCountValidator),
  handler: async (ctx) => {
    const all = await ctx.db.query('data_tables').collect()
    const live = all.filter((t) => t.deleted_at === null).sort(compareTables)
    const out = []
    for (const t of live) {
      const row_count = await countLiveRows(ctx, t.id)
      out.push({ ...toRow(t), row_count })
    }
    return out
  },
})

/** A single non-deleted table by app id, or `null`. */
export const get = query({
  args: { tableId: v.string() },
  returns: v.union(v.null(), tableRowValidator),
  handler: async (ctx, { tableId }) => {
    const t = await tableByAppId(ctx, tableId)
    if (!t || t.deleted_at !== null) return null
    return toRow(t)
  },
})

/** A single non-deleted table by slug (indexed `by_slug`), or `null`. */
export const getBySlug = query({
  args: { slug: v.string() },
  returns: v.union(v.null(), tableRowValidator),
  handler: async (ctx, { slug }) => {
    const matches = await ctx.db
      .query('data_tables')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .collect()
    const t = matches.find((m) => m.deleted_at === null)
    return t ? toRow(t) : null
  },
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a table. `id` is generated here when absent; `created_at` /
 * `updated_at` are stamped here; `system` takes the old SQL default (`false`).
 * The repository has already normalised `routeBase` + `fieldsJson` and resolved
 * the `kind` / `primaryFieldId` / actor defaults. Rejects a duplicate live slug
 * (§4.6). Returns the freshly written wire row.
 */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    name: v.string(),
    slug: v.string(),
    kind: kindValidator,
    routeBase: v.string(),
    singularLabel: v.string(),
    pluralLabel: v.string(),
    primaryFieldId: v.string(),
    fieldsJson: v.string(),
    createdByUserId: v.union(v.null(), v.string()),
    updatedByUserId: v.union(v.null(), v.string()),
  },
  returns: tableRowValidator,
  handler: async (ctx, args) => {
    await assertSlugFree(ctx, args.slug, null)
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('data_tables', {
      id: args.id ?? nanoid(),
      name: args.name,
      slug: args.slug,
      kind: args.kind,
      route_base: args.routeBase,
      singular_label: args.singularLabel,
      plural_label: args.pluralLabel,
      primary_field_id: args.primaryFieldId,
      fields_json: args.fieldsJson,
      system: false,
      created_by_user_id: args.createdByUserId,
      updated_by_user_id: args.updatedByUserId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    const fresh = await ctx.db.get(docId)
    return toRow(fresh!)
  },
})

/**
 * Insert a table only when its `id` is absent — the SQL `on conflict (id) do
 * nothing`. Returns `true` when inserted, `false` when the id already existed
 * (live or soft-deleted, matching the primary-key conflict). A *slug* collision
 * is a different constraint, so it still throws (`assertSlugFree`), exactly like
 * the SQL unique index would. Used by the merge import strategies.
 */
export const insertIfAbsent = mutation({
  args: {
    id: v.optional(v.string()),
    name: v.string(),
    slug: v.string(),
    kind: kindValidator,
    routeBase: v.string(),
    singularLabel: v.string(),
    pluralLabel: v.string(),
    primaryFieldId: v.string(),
    fieldsJson: v.string(),
    createdByUserId: v.union(v.null(), v.string()),
    updatedByUserId: v.union(v.null(), v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const id = args.id ?? nanoid()
    const existing = await tableByAppId(ctx, id)
    if (existing) return false
    await assertSlugFree(ctx, args.slug, null)
    const now = new Date().toISOString()
    await ctx.db.insert('data_tables', {
      id,
      name: args.name,
      slug: args.slug,
      kind: args.kind,
      route_base: args.routeBase,
      singular_label: args.singularLabel,
      plural_label: args.pluralLabel,
      primary_field_id: args.primaryFieldId,
      fields_json: args.fieldsJson,
      system: false,
      created_by_user_id: args.createdByUserId,
      updated_by_user_id: args.updatedByUserId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    return true
  },
})

/**
 * Partial update of a live table. Each field is patched only when supplied —
 * the SQL `coalesce(?, col)` semantics. `routeBase` / `fieldsJson` arrive
 * already normalised from the repository; `updatedByUserId` is only ever a
 * concrete string here (a `null`/absent value means "keep", per the old
 * `coalesce(updated_by_user_id ?? null, …)`). Re-checks slug uniqueness when the
 * slug changes. Returns the re-read wire row, or `null` if the target is
 * missing / soft-deleted.
 */
export const update = mutation({
  args: {
    tableId: v.string(),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    routeBase: v.optional(v.string()),
    singularLabel: v.optional(v.string()),
    pluralLabel: v.optional(v.string()),
    primaryFieldId: v.optional(v.string()),
    fieldsJson: v.optional(v.string()),
    updatedByUserId: v.optional(v.string()),
  },
  returns: v.union(v.null(), tableRowValidator),
  handler: async (ctx, args) => {
    const t = await tableByAppId(ctx, args.tableId)
    if (!t || t.deleted_at !== null) return null

    if (args.slug !== undefined && args.slug !== t.slug) {
      await assertSlugFree(ctx, args.slug, t.id)
    }

    const patch: Partial<WithoutSystemFields<Doc<'data_tables'>>> = {
      updated_at: new Date().toISOString(),
    }
    if (args.name !== undefined) patch.name = args.name
    if (args.slug !== undefined) patch.slug = args.slug
    if (args.routeBase !== undefined) patch.route_base = args.routeBase
    if (args.singularLabel !== undefined) patch.singular_label = args.singularLabel
    if (args.pluralLabel !== undefined) patch.plural_label = args.pluralLabel
    if (args.primaryFieldId !== undefined) patch.primary_field_id = args.primaryFieldId
    if (args.fieldsJson !== undefined) patch.fields_json = args.fieldsJson
    if (args.updatedByUserId !== undefined) patch.updated_by_user_id = args.updatedByUserId

    await ctx.db.patch(t._id, patch)
    const fresh = await ctx.db.get(t._id)
    return toRow(fresh!)
  },
})

/**
 * Soft-delete a table, atomically. Refuses (returns `null`) when the table is
 * missing / already deleted, is a `system` table, or still has any non-deleted
 * row. The row-count guard — formerly a separate `countDataRows` statement —
 * runs inside this mutation so the check and the delete cannot interleave (§3).
 */
export const softDelete = mutation({
  args: {
    tableId: v.string(),
    actorUserId: v.union(v.null(), v.string()),
  },
  returns: v.union(v.null(), tableRowValidator),
  handler: async (ctx, { tableId, actorUserId }) => {
    const t = await tableByAppId(ctx, tableId)
    if (!t || t.deleted_at !== null) return null
    if (t.system === true) return null
    if ((await countLiveRows(ctx, tableId)) > 0) return null

    const now = new Date().toISOString()
    await ctx.db.patch(t._id, {
      deleted_at: now,
      updated_by_user_id: actorUserId,
      updated_at: now,
    })
    const fresh = await ctx.db.get(t._id)
    return toRow(fresh!)
  },
})

// ---------------------------------------------------------------------------
// Version-number allocation (data_row_versions)
// ---------------------------------------------------------------------------

/**
 * Next `version_number` for a row: `max(existing) + 1`, or `1` when the row has
 * no versions yet. Reads the most-recent version off the `by_row_version` index
 * (`row_id`, `version_number`) — the descending `.first()` is the max.
 *
 * This is the STANDALONE allocator for non-atomic callers (e.g. the whole-site
 * publish in `server/publish/publishSite.ts`). The per-row atomic publish flow
 * allocates + inserts versions inside its own mutation and does NOT round-trip
 * through here.
 */
export const nextVersionNumber = query({
  args: { rowId: v.string() },
  returns: v.number(),
  handler: async (ctx, { rowId }) => {
    const latest = await ctx.db
      .query('data_row_versions')
      .withIndex('by_row_version', (q) => q.eq('row_id', rowId))
      .order('desc')
      .first()
    return latest ? latest.version_number + 1 : 1
  },
})
