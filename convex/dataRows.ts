/**
 * Data rows — Convex functions.
 *
 * The Convex half of the `data_rows` domain; the thin repository adapters under
 * `server/repositories/data/rows/*.ts` marshal args into these and map the
 * results back into the frozen `DataRow` / `DeletedRowSummary` shapes
 * (docs/CONVEX-MIGRATION.md §2). The split mirrors the proven `users` slice:
 *
 * - **Hydration stays in the repository.** Every hydrated read here returns a
 *   *joined row* — the data_row columns plus the four user-ref column groups
 *   (`<prefix>_email` / `_display_name` / `_role_slug` / `_role_name` for
 *   author / created_by / updated_by / published_by) — shaped exactly like the
 *   repository's internal `DataRowRow`. The repository's `mapRow` (via the
 *   shared `userRefAt` hydrator in `server/repositories/data/shared.ts`) turns
 *   that joined row into a `DataRow`. This keeps ONE hydration path and keeps
 *   the `@core` capability/date helpers out of the Convex V8 runtime.
 * - **The SQL `LEFT JOIN users LEFT JOIN roles` (×4) becomes a hand-assembled
 *   join** (`resolveUserCols` + `hydrate`): fetch each ref's user by app id,
 *   then its role by app id, merge in JS (§4.2). A per-call cache dedupes the
 *   repeated author/editor lookups across a list.
 * - **`cells_json` is an opaque JSON string at rest** (§6); it is `JSON.parse`d
 *   here into the object `mapRow` expects, and `JSON.stringify`d on write.
 * - **No `json_extract`.** The operator-DSL filter (`listWithFilter`) fetches
 *   the table's candidate rows by index, parses `cells_json`, and applies the
 *   eq/ne/gt/gte/lt/lte/in/like operators in JS (§4.2). Cross-table slug search
 *   scans + JS-substring matches (§4.3) — there is no denormalized search text
 *   to back a `.searchIndex`.
 *
 * Transactions collapsed to single atomic mutations (docs/CONVEX-MIGRATION.md
 * §3): `createMany` (#10), `saveDraftMany` (#11), `softDeleteMany` (#12),
 * `reconcileRoster` (#9 — reap + two-phase slug park/finalize + create/revive,
 * load-bearing statement order preserved). Version WRITES on publish are NOT
 * here — they belong to the publish slice.
 *
 * App identity is the nanoid `id`, generated here when not supplied;
 * `created_at` / `updated_at` (SQL column defaults) are stamped here. Convex
 * `_id` never leaks out. Every function declares both `args` AND `returns`
 * validators.
 *
 * @see server/repositories/data/rows/*.ts — the thin repository adapters
 * @see server/repositories/data/shared.ts — userRefAt, the JS user-ref hydrator
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const nullableString = v.union(v.null(), v.string())

const statusValidator = v.union(
  v.literal('draft'),
  v.literal('published'),
  v.literal('unpublished'),
  v.literal('scheduled'),
)

/**
 * The joined data-row shape consumed by the repository's `mapRow`. Base
 * `data_rows` columns + the four user-ref column groups. `cells_json` is the
 * already-parsed object (the repository never re-parses it).
 */
const dataRowRowValidator = v.object({
  id: v.string(),
  table_id: v.string(),
  cells_json: v.record(v.string(), v.any()),
  slug: v.string(),
  status: statusValidator,
  author_user_id: nullableString,
  created_by_user_id: nullableString,
  updated_by_user_id: nullableString,
  published_by_user_id: nullableString,
  author_email: nullableString,
  author_display_name: nullableString,
  author_role_slug: nullableString,
  author_role_name: nullableString,
  created_by_email: nullableString,
  created_by_display_name: nullableString,
  created_by_role_slug: nullableString,
  created_by_role_name: nullableString,
  updated_by_email: nullableString,
  updated_by_display_name: nullableString,
  updated_by_role_slug: nullableString,
  updated_by_role_name: nullableString,
  published_by_email: nullableString,
  published_by_display_name: nullableString,
  published_by_role_slug: nullableString,
  published_by_role_name: nullableString,
  created_at: v.string(),
  updated_at: v.string(),
  published_at: nullableString,
  scheduled_publish_at: nullableString,
  deleted_at: nullableString,
})

/** The narrow shape a soft-delete returns (the repository's `DeletedRowSummary`). */
const deletedRowSummaryValidator = v.object({
  id: v.string(),
  tableId: v.string(),
  slug: v.string(),
  status: statusValidator,
  deletedAt: nullableString,
})

// ---------------------------------------------------------------------------
// Lookup + hydration helpers (the hand-assembled user-ref joins)
// ---------------------------------------------------------------------------

function rowByAppId(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db
    .query('data_rows')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

interface UserCols {
  email: string | null
  display_name: string | null
  role_slug: string | null
  role_name: string | null
}

const EMPTY_USER_COLS: UserCols = {
  email: null,
  display_name: null,
  role_slug: null,
  role_name: null,
}

type UserColsCache = Map<string, UserCols>

/**
 * Resolve one user-ref's denormalized columns (the SQL `LEFT JOIN users LEFT
 * JOIN roles`). `null` user id → all-null columns (the join found nothing). A
 * missing user → all-null. A present user whose role is missing keeps the user
 * columns and nulls the role columns (matches the LEFT JOIN on roles).
 */
async function resolveUserCols(
  ctx: QueryCtx | MutationCtx,
  userId: string | null,
  cache: UserColsCache,
): Promise<UserCols> {
  if (userId === null) return EMPTY_USER_COLS
  const cached = cache.get(userId)
  if (cached) return cached
  const user = await ctx.db
    .query('users')
    .withIndex('by_app_id', (q) => q.eq('id', userId))
    .unique()
  let cols: UserCols
  if (!user) {
    cols = EMPTY_USER_COLS
  } else {
    const role = await ctx.db
      .query('roles')
      .withIndex('by_app_id', (q) => q.eq('id', user.role_id))
      .unique()
    cols = {
      email: user.email,
      display_name: user.display_name,
      role_slug: role ? role.slug : null,
      role_name: role ? role.name : null,
    }
  }
  cache.set(userId, cols)
  return cols
}

/** Hand-assemble the joined row (base columns + four hydrated user-ref groups). */
async function hydrate(
  ctx: QueryCtx | MutationCtx,
  row: Doc<'data_rows'>,
  cache: UserColsCache,
) {
  const author = await resolveUserCols(ctx, row.author_user_id, cache)
  const createdBy = await resolveUserCols(ctx, row.created_by_user_id, cache)
  const updatedBy = await resolveUserCols(ctx, row.updated_by_user_id, cache)
  const publishedBy = await resolveUserCols(ctx, row.published_by_user_id, cache)
  return {
    id: row.id,
    table_id: row.table_id,
    cells_json: JSON.parse(row.cells_json) as Record<string, unknown>,
    slug: row.slug,
    status: row.status,
    author_user_id: row.author_user_id,
    created_by_user_id: row.created_by_user_id,
    updated_by_user_id: row.updated_by_user_id,
    published_by_user_id: row.published_by_user_id,
    author_email: author.email,
    author_display_name: author.display_name,
    author_role_slug: author.role_slug,
    author_role_name: author.role_name,
    created_by_email: createdBy.email,
    created_by_display_name: createdBy.display_name,
    created_by_role_slug: createdBy.role_slug,
    created_by_role_name: createdBy.role_name,
    updated_by_email: updatedBy.email,
    updated_by_display_name: updatedBy.display_name,
    updated_by_role_slug: updatedBy.role_slug,
    updated_by_role_name: updatedBy.role_name,
    published_by_email: publishedBy.email,
    published_by_display_name: publishedBy.display_name,
    published_by_role_slug: publishedBy.role_slug,
    published_by_role_name: publishedBy.role_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    scheduled_publish_at: row.scheduled_publish_at,
    deleted_at: row.deleted_at,
  }
}

/** Re-read a just-written row by its Convex doc id and hydrate it. */
async function reload(ctx: MutationCtx, docId: Id<'data_rows'>, cache: UserColsCache) {
  const fresh = await ctx.db.get(docId)
  if (!fresh) return null
  return hydrate(ctx, fresh, cache)
}

/** All non-deleted rows of a table, in the SQL `updated_at desc, created_at desc` order. */
async function tableRowsNewestFirst(
  ctx: QueryCtx | MutationCtx,
  tableId: string,
): Promise<Doc<'data_rows'>[]> {
  const rows = await ctx.db
    .query('data_rows')
    .withIndex('by_table_updated', (q) => q.eq('table_id', tableId))
    .collect()
  return rows
    .filter((r) => r.deleted_at === null)
    .sort((a, b) => {
      if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
      return 0
    })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Non-deleted rows in a table, newest first (the visibility filter stays in the repo). */
export const list = query({
  args: { tableId: v.string() },
  returns: v.array(dataRowRowValidator),
  handler: async (ctx, { tableId }) => {
    const cache: UserColsCache = new Map()
    const rows = await tableRowsNewestFirst(ctx, tableId)
    const out = []
    for (const row of rows) out.push(await hydrate(ctx, row, cache))
    return out
  },
})

/** Lightweight `(id, slug)` projection of a table's non-deleted rows. */
export const listIdSlugs = query({
  args: { tableId: v.string() },
  returns: v.array(v.object({ id: v.string(), slug: v.string() })),
  handler: async (ctx, { tableId }) => {
    const rows = await ctx.db
      .query('data_rows')
      .withIndex('by_table_updated', (q) => q.eq('table_id', tableId))
      .collect()
    return rows
      .filter((r) => r.deleted_at === null)
      .map((r) => ({ id: r.id, slug: r.slug }))
  },
})

/** Hydrate a single non-deleted row by app id, or `null`. */
export const getById = query({
  args: { rowId: v.string() },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, { rowId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) return null
    return hydrate(ctx, row, new Map())
  },
})

/** Hydrate many non-deleted rows by app id (the SQL `IN`-list read). */
export const getMany = query({
  args: { rowIds: v.array(v.string()) },
  returns: v.array(dataRowRowValidator),
  handler: async (ctx, { rowIds }) => {
    const cache: UserColsCache = new Map()
    const out = []
    for (const rowId of rowIds) {
      const row = await rowByAppId(ctx, rowId)
      if (row && row.deleted_at === null) out.push(await hydrate(ctx, row, cache))
    }
    return out
  },
})

/** Hydrate a non-deleted row in a table by its denormalized slug, or `null`. */
export const getBySlug = query({
  args: { tableId: v.string(), slug: v.string() },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, { tableId, slug }) => {
    const matches = await ctx.db
      .query('data_rows')
      .withIndex('by_table_slug', (q) => q.eq('table_id', tableId).eq('slug', slug))
      .collect()
    const row = matches.find((r) => r.deleted_at === null)
    if (!row) return null
    return hydrate(ctx, row, new Map())
  },
})

/** Count non-deleted rows in a table. */
export const count = query({
  args: { tableId: v.string() },
  returns: v.number(),
  handler: async (ctx, { tableId }) => {
    const rows = await ctx.db
      .query('data_rows')
      .withIndex('by_table_updated', (q) => q.eq('table_id', tableId))
      .collect()
    return rows.filter((r) => r.deleted_at === null).length
  },
})

/** Active, non-deleted users for the author picker, ordered by display name then email. */
export const listAuthorOptions = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.string(),
      email: v.string(),
      displayName: v.string(),
      roleSlug: nullableString,
      roleName: nullableString,
    }),
  ),
  handler: async (ctx) => {
    const users = await ctx.db.query('users').collect()
    const active = users
      .filter((u) => u.deleted_at === null && u.status === 'active')
      .sort((a, b) => {
        if (a.display_name !== b.display_name) return a.display_name < b.display_name ? -1 : 1
        if (a.email !== b.email) return a.email < b.email ? -1 : 1
        return 0
      })
    const out = []
    for (const user of active) {
      const role = await ctx.db
        .query('roles')
        .withIndex('by_app_id', (q) => q.eq('id', user.role_id))
        .unique()
      out.push({
        id: user.id,
        email: user.email,
        displayName: user.display_name || user.email || user.id,
        roleSlug: role ? role.slug : null,
        roleName: role ? role.name : null,
      })
    }
    return out
  },
})

// ---------------------------------------------------------------------------
// Cross-table slug search (§4.3 — full scan + JS substring; no search index)
// ---------------------------------------------------------------------------

export const search = query({
  args: { query: v.string(), limit: v.number() },
  returns: v.array(
    v.object({
      id: v.string(),
      tableId: v.string(),
      tableSlug: v.string(),
      tableName: v.string(),
      slug: v.string(),
      status: statusValidator,
      updatedAt: v.string(),
      authorUserId: nullableString,
      createdByUserId: nullableString,
    }),
  ),
  handler: async (ctx, { query: rawQuery, limit }) => {
    const needle = rawQuery.toLowerCase()
    const tables = await ctx.db.query('data_tables').collect()
    const tableById = new Map(
      tables.filter((t) => t.deleted_at === null).map((t) => [t.id, t]),
    )

    const rows = await ctx.db.query('data_rows').collect()
    const matched = rows
      .filter(
        (r) =>
          r.deleted_at === null &&
          tableById.has(r.table_id) &&
          r.slug.toLowerCase().includes(needle),
      )
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, limit)

    return matched.map((r) => {
      const table = tableById.get(r.table_id)!
      return {
        id: r.id,
        tableId: r.table_id,
        tableSlug: table.slug,
        tableName: table.name,
        slug: r.slug,
        status: r.status,
        updatedAt: r.updated_at,
        authorUserId: r.author_user_id,
        createdByUserId: r.created_by_user_id,
      }
    })
  },
})

// ---------------------------------------------------------------------------
// Operator-DSL filter (§4.2 — candidates by index, parse + filter in JS)
// ---------------------------------------------------------------------------

const ROW_LEVEL_KEYS = new Set(['slug', 'status', 'created_at', 'updated_at', 'published_at'])

/** SQL `LIKE` semantics over a string value (`%` → any run, `_` → any char). */
function likeMatch(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false
  const escaped = pattern
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.')
  return new RegExp(`^${escaped}$`).test(value.toLowerCase())
}

/** Total order over the heterogeneous JSON-cell values (null-low; numeric vs lexical). */
function compareUnknown(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

function matchesFilter(cells: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const fieldVal = cells[key]
    if (value === null || typeof value !== 'object') {
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

function orderValue(row: Doc<'data_rows'>, cells: Record<string, unknown>, key: string): unknown {
  if (ROW_LEVEL_KEYS.has(key)) return (row as unknown as Record<string, unknown>)[key]
  return cells[key]
}

export const listWithFilter = query({
  args: {
    tableId: v.string(),
    filter: v.optional(v.any()),
    orderBy: v.optional(v.any()),
    status: v.optional(
      v.union(
        v.literal('any'),
        v.literal('draft'),
        v.literal('published'),
        v.literal('scheduled'),
      ),
    ),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  returns: v.object({ rows: v.array(dataRowRowValidator), totalCount: v.number() }),
  handler: async (ctx, args) => {
    const status = args.status ?? 'any'
    const filter = (args.filter ?? undefined) as Record<string, unknown> | undefined
    const orderBy = (args.orderBy ?? undefined) as Record<string, 'asc' | 'desc'> | undefined
    const limit = Math.max(1, Math.min(500, args.limit ?? 100))
    const offset = Math.max(0, args.offset ?? 0)

    const all = await ctx.db
      .query('data_rows')
      .withIndex('by_table_updated', (q) => q.eq('table_id', args.tableId))
      .collect()

    const parsed = all
      .filter((r) => r.deleted_at === null && (status === 'any' || r.status === status))
      .map((row) => ({ row, cells: JSON.parse(row.cells_json) as Record<string, unknown> }))

    const matched = filter
      ? parsed.filter(({ cells }) => matchesFilter(cells, filter))
      : parsed

    const orderEntries =
      orderBy && Object.keys(orderBy).length > 0
        ? Object.entries(orderBy)
        : ([
            ['updated_at', 'desc'],
            ['created_at', 'desc'],
          ] as Array<[string, 'asc' | 'desc']>)

    matched.sort((a, b) => {
      for (const [key, dir] of orderEntries) {
        const cmp = compareUnknown(orderValue(a.row, a.cells, key), orderValue(b.row, b.cells, key))
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
      }
      return 0
    })

    const totalCount = matched.length
    const page = matched.slice(offset, offset + limit)
    const cache: UserColsCache = new Map()
    const rows = []
    for (const { row } of page) rows.push(await hydrate(ctx, row, cache))
    return { rows, totalCount }
  },
})

// ---------------------------------------------------------------------------
// Single-row writes
// ---------------------------------------------------------------------------

/** Insert a new draft row; returns the hydrated joined row. */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    tableId: v.string(),
    cells: v.any(),
    slug: v.string(),
    actorUserId: v.union(v.null(), v.string()),
    pluginActorId: v.union(v.null(), v.string()),
  },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('data_rows', {
      id: args.id ?? nanoid(),
      table_id: args.tableId,
      cells_json: JSON.stringify(args.cells),
      slug: args.slug,
      status: 'draft',
      active_version_id: null,
      author_user_id: args.actorUserId,
      created_by_user_id: args.actorUserId,
      updated_by_user_id: args.actorUserId,
      published_by_user_id: null,
      created_at: now,
      updated_at: now,
      published_at: null,
      scheduled_publish_at: null,
      deleted_at: null,
      plugin_actor_id: args.pluginActorId,
    })
    return reload(ctx, docId, new Map())
  },
})

/** Overwrite the draft cells + slug; returns the hydrated joined row (or `null`). */
export const saveDraft = mutation({
  args: {
    rowId: v.string(),
    cells: v.any(),
    slug: v.string(),
    actorUserId: v.union(v.null(), v.string()),
    pluginActorId: v.union(v.null(), v.string()),
  },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, args) => {
    const row = await rowByAppId(ctx, args.rowId)
    if (!row || row.deleted_at !== null) return null
    await ctx.db.patch(row._id, {
      cells_json: JSON.stringify(args.cells),
      slug: args.slug,
      updated_by_user_id: args.actorUserId,
      plugin_actor_id: args.pluginActorId,
      updated_at: new Date().toISOString(),
    })
    return reload(ctx, row._id, new Map())
  },
})

/** The write half of `saveDraft` with no re-read — returns whether a live row matched. */
export const updateDraftCells = mutation({
  args: {
    rowId: v.string(),
    cells: v.any(),
    slug: v.string(),
    actorUserId: v.union(v.null(), v.string()),
    pluginActorId: v.union(v.null(), v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await rowByAppId(ctx, args.rowId)
    if (!row || row.deleted_at !== null) return false
    await ctx.db.patch(row._id, {
      cells_json: JSON.stringify(args.cells),
      slug: args.slug,
      updated_by_user_id: args.actorUserId,
      plugin_actor_id: args.pluginActorId,
      updated_at: new Date().toISOString(),
    })
    return true
  },
})

/** Soft-delete a row; returns the narrow `DeletedRowSummary`, or `null` if no live row. */
export const softDelete = mutation({
  args: { rowId: v.string(), actorUserId: v.union(v.null(), v.string()) },
  returns: v.union(v.null(), deletedRowSummaryValidator),
  handler: async (ctx, { rowId, actorUserId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) return null
    const now = new Date().toISOString()
    await ctx.db.patch(row._id, {
      deleted_at: now,
      updated_by_user_id: actorUserId,
      updated_at: now,
    })
    return {
      id: row.id,
      tableId: row.table_id,
      slug: row.slug,
      status: row.status,
      deletedAt: now,
    }
  },
})

/**
 * Move a row to another table. Replicates the SQL guards: row-not-found,
 * target-table-not-found, and the active-slug-conflict check. `wasPublished`
 * tells the repository whether to bump the public render cache (the row's
 * route changes only for an already-published row).
 */
export const updateTable = mutation({
  args: { rowId: v.string(), tableId: v.string(), actorUserId: v.union(v.null(), v.string()) },
  returns: v.union(
    v.object({
      ok: v.literal(false),
      reason: v.union(
        v.literal('row_not_found'),
        v.literal('table_not_found'),
        v.literal('slug_conflict'),
      ),
    }),
    v.object({ ok: v.literal(true), row: dataRowRowValidator, wasPublished: v.boolean() }),
  ),
  handler: async (ctx, { rowId, tableId, actorUserId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) return { ok: false as const, reason: 'row_not_found' as const }
    if (row.table_id === tableId) {
      return { ok: true as const, row: await hydrate(ctx, row, new Map()), wasPublished: false }
    }

    const table = await ctx.db
      .query('data_tables')
      .withIndex('by_app_id', (q) => q.eq('id', tableId))
      .unique()
    if (!table || table.deleted_at !== null) {
      return { ok: false as const, reason: 'table_not_found' as const }
    }

    if (row.slug) {
      const conflicts = await ctx.db
        .query('data_rows')
        .withIndex('by_table_slug', (q) => q.eq('table_id', tableId).eq('slug', row.slug))
        .collect()
      if (conflicts.some((r) => r.deleted_at === null && r.id !== rowId)) {
        return { ok: false as const, reason: 'slug_conflict' as const }
      }
    }

    const wasPublished = row.status === 'published'
    await ctx.db.patch(row._id, {
      table_id: tableId,
      updated_by_user_id: actorUserId,
      updated_at: new Date().toISOString(),
    })
    const updated = await reload(ctx, row._id, new Map())
    if (!updated) return { ok: false as const, reason: 'row_not_found' as const }
    return { ok: true as const, row: updated, wasPublished }
  },
})

/**
 * Flip a row between `draft` and `unpublished`, always clearing publish +
 * schedule metadata. Returns the hydrated row, or `null` if no live row matched
 * (the repository bumps the render cache whenever a row matched).
 */
export const updateStatus = mutation({
  args: {
    rowId: v.string(),
    status: v.union(v.literal('draft'), v.literal('unpublished')),
    actorUserId: v.union(v.null(), v.string()),
  },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, { rowId, status, actorUserId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) return null
    await ctx.db.patch(row._id, {
      status,
      published_at: null,
      published_by_user_id: null,
      scheduled_publish_at: null,
      updated_by_user_id: actorUserId,
      updated_at: new Date().toISOString(),
    })
    return reload(ctx, row._id, new Map())
  },
})

/** Reassign a row's author; returns the hydrated row (or `null`). */
export const updateAuthor = mutation({
  args: { rowId: v.string(), authorUserId: v.string(), actorUserId: v.union(v.null(), v.string()) },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, { rowId, authorUserId, actorUserId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) return null
    await ctx.db.patch(row._id, {
      author_user_id: authorUserId,
      updated_by_user_id: actorUserId,
      updated_at: new Date().toISOString(),
    })
    return reload(ctx, row._id, new Map())
  },
})

// ---------------------------------------------------------------------------
// Bulk writes — each loop is one atomic mutation (§3 #10–12)
// ---------------------------------------------------------------------------

/** Bulk-insert N draft rows in one atomic mutation. Each input carries its own table. */
export const createMany = mutation({
  args: {
    inputs: v.array(
      v.object({ id: v.optional(v.string()), tableId: v.string(), cells: v.any(), slug: v.string() }),
    ),
    actorUserId: v.union(v.null(), v.string()),
    pluginActorId: v.union(v.null(), v.string()),
  },
  returns: v.array(dataRowRowValidator),
  handler: async (ctx, args) => {
    const cache: UserColsCache = new Map()
    const created = []
    for (const input of args.inputs) {
      const now = new Date().toISOString()
      const docId = await ctx.db.insert('data_rows', {
        id: input.id ?? nanoid(),
        table_id: input.tableId,
        cells_json: JSON.stringify(input.cells),
        slug: input.slug,
        status: 'draft',
        active_version_id: null,
        author_user_id: args.actorUserId,
        created_by_user_id: args.actorUserId,
        updated_by_user_id: args.actorUserId,
        published_by_user_id: null,
        created_at: now,
        updated_at: now,
        published_at: null,
        scheduled_publish_at: null,
        deleted_at: null,
        plugin_actor_id: args.pluginActorId,
      })
      const row = await reload(ctx, docId, cache)
      if (row) created.push(row)
    }
    return created
  },
})

/** Bulk-update N rows' draft cells + slug in one atomic mutation. */
export const saveDraftMany = mutation({
  args: {
    updates: v.array(v.object({ id: v.string(), cells: v.any(), slug: v.string() })),
    actorUserId: v.union(v.null(), v.string()),
    pluginActorId: v.union(v.null(), v.string()),
  },
  returns: v.array(dataRowRowValidator),
  handler: async (ctx, args) => {
    const cache: UserColsCache = new Map()
    const updated = []
    for (const { id, cells, slug } of args.updates) {
      const row = await rowByAppId(ctx, id)
      if (!row || row.deleted_at !== null) continue
      await ctx.db.patch(row._id, {
        cells_json: JSON.stringify(cells),
        slug,
        updated_by_user_id: args.actorUserId,
        plugin_actor_id: args.pluginActorId,
        updated_at: new Date().toISOString(),
      })
      const fresh = await reload(ctx, row._id, cache)
      if (fresh) updated.push(fresh)
    }
    return updated
  },
})

/**
 * Bulk-soft-delete N rows in one atomic mutation. Returns how many rows were
 * actually deleted and how many of those were `published` (the repository bumps
 * the render cache AFTER the mutation, never inside).
 */
export const softDeleteMany = mutation({
  args: { rowIds: v.array(v.string()), actorUserId: v.union(v.null(), v.string()) },
  returns: v.object({ deleted: v.number(), publishedDeleted: v.number() }),
  handler: async (ctx, { rowIds, actorUserId }) => {
    let deleted = 0
    let publishedDeleted = 0
    for (const id of rowIds) {
      const row = await rowByAppId(ctx, id)
      if (!row || row.deleted_at !== null) continue
      const now = new Date().toISOString()
      const wasPublished = row.status === 'published'
      await ctx.db.patch(row._id, {
        deleted_at: now,
        updated_by_user_id: actorUserId,
        updated_at: now,
      })
      deleted++
      if (wasPublished) publishedDeleted++
    }
    return { deleted, publishedDeleted }
  },
})

// ---------------------------------------------------------------------------
// Roster reconcile — one atomic mutation (§3 #9, load-bearing order preserved)
// ---------------------------------------------------------------------------

/**
 * Reconcile a table's rows to the client's roster in ONE atomic mutation:
 *
 *   1. Reap first — soft-delete the rows the client knew about and dropped,
 *      freeing their slugs for the writes below.
 *   2. Two-phase slug writes — slug-changing updates are parked on the empty
 *      slug together with their cells, then finalized in a second pass once
 *      every old slug is free (so within-batch swaps never transiently
 *      collide). A write whose id matches a soft-deleted row revives it.
 *
 * Convex mutations are atomic with no unique-index constraint, so the
 * placeholder dance is not strictly required for correctness — but the exact
 * statement order is replicated to preserve the SQL semantics faithfully. The
 * `rowsToReap` predicate is reimplemented inline (the repository's pure helper
 * cannot be imported into the Convex runtime).
 */
export const reconcileRoster = mutation({
  args: {
    tableId: v.string(),
    writes: v.array(v.object({ id: v.string(), cells: v.any(), slug: v.string() })),
    keepIds: v.array(v.string()),
    baselineIds: v.optional(v.array(v.string())),
    actorUserId: v.string(),
  },
  returns: v.object({ reapedPublished: v.boolean() }),
  handler: async (ctx, args) => {
    const keep = new Set(args.keepIds)
    const baseline = args.baselineIds ? new Set(args.baselineIds) : undefined

    const existing = await ctx.db
      .query('data_rows')
      .withIndex('by_table_updated', (q) => q.eq('table_id', args.tableId))
      .collect()
    const activeById = new Map(existing.filter((r) => r.deleted_at === null).map((r) => [r.id, r]))
    const softDeletedById = new Map(
      existing.filter((r) => r.deleted_at !== null).map((r) => [r.id, r]),
    )

    let reapedPublished = false
    const now = () => new Date().toISOString()

    // 1. Reap first.
    for (const [id, row] of activeById) {
      const reap = !keep.has(id) && (baseline ? baseline.has(id) : true)
      if (!reap) continue
      const ts = now()
      const wasPublished = row.status === 'published'
      await ctx.db.patch(row._id, {
        deleted_at: ts,
        updated_by_user_id: args.actorUserId,
        updated_at: ts,
      })
      activeById.delete(id)
      if (wasPublished) reapedPublished = true
    }

    // 2a. Updates to existing rows; slug-changers parked on ''.
    const parked: Array<{ id: string; slug: string }> = []
    for (const write of args.writes) {
      const stored = activeById.get(write.id)
      if (!stored) continue // created or revived below
      if (stored.slug === write.slug) {
        await ctx.db.patch(stored._id, {
          cells_json: JSON.stringify(write.cells),
          slug: write.slug,
          updated_by_user_id: args.actorUserId,
          updated_at: now(),
        })
      } else {
        await ctx.db.patch(stored._id, {
          cells_json: JSON.stringify(write.cells),
          slug: '',
          updated_by_user_id: args.actorUserId,
          updated_at: now(),
        })
        parked.push({ id: write.id, slug: write.slug })
      }
    }

    // 2b. Creates / revivals.
    for (const write of args.writes) {
      if (activeById.has(write.id)) continue
      const dead = softDeletedById.get(write.id)
      if (dead) {
        const ts = now()
        await ctx.db.patch(dead._id, {
          deleted_at: null,
          cells_json: JSON.stringify(write.cells),
          slug: '',
          updated_by_user_id: args.actorUserId,
          updated_at: ts,
        })
        parked.push({ id: write.id, slug: write.slug })
      } else {
        const ts = now()
        await ctx.db.insert('data_rows', {
          id: write.id,
          table_id: args.tableId,
          cells_json: JSON.stringify(write.cells),
          slug: write.slug,
          status: 'draft',
          active_version_id: null,
          author_user_id: args.actorUserId,
          created_by_user_id: args.actorUserId,
          updated_by_user_id: args.actorUserId,
          published_by_user_id: null,
          created_at: ts,
          updated_at: ts,
          published_at: null,
          scheduled_publish_at: null,
          deleted_at: null,
          plugin_actor_id: null,
        })
      }
    }

    // 3. Finalize parked slugs — every old slug is free by now.
    for (const { id, slug } of parked) {
      const row = await rowByAppId(ctx, id)
      if (row && row.deleted_at === null) await ctx.db.patch(row._id, { slug })
    }

    return { reapedPublished }
  },
})

// ---------------------------------------------------------------------------
// Scheduled-publish lifecycle
// ---------------------------------------------------------------------------

/** Mark a row `scheduled` for a future publish; returns the hydrated row. */
export const schedulePublish = mutation({
  args: { rowId: v.string(), whenIso: v.string(), actorUserId: v.union(v.null(), v.string()) },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, { rowId, whenIso, actorUserId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) return null
    await ctx.db.patch(row._id, {
      status: 'scheduled',
      scheduled_publish_at: whenIso,
      published_at: null,
      published_by_user_id: null,
      updated_by_user_id: actorUserId,
      updated_at: new Date().toISOString(),
    })
    return reload(ctx, row._id, new Map())
  },
})

/** Cancel a pending scheduled publish (only when `status='scheduled'`); revert to draft. */
export const cancelScheduledPublish = mutation({
  args: { rowId: v.string(), actorUserId: v.union(v.null(), v.string()) },
  returns: v.union(v.null(), dataRowRowValidator),
  handler: async (ctx, { rowId, actorUserId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null || row.status !== 'scheduled') return null
    await ctx.db.patch(row._id, {
      status: 'draft',
      scheduled_publish_at: null,
      updated_by_user_id: actorUserId,
      updated_at: new Date().toISOString(),
    })
    return reload(ctx, row._id, new Map())
  },
})

/** Scheduled rows whose target time has passed, oldest first (the scheduler tick). */
export const listDuePublishSchedules = query({
  args: { nowIso: v.string(), limit: v.number() },
  returns: v.array(
    v.object({ rowId: v.string(), tableId: v.string(), scheduledPublishAt: v.string() }),
  ),
  handler: async (ctx, { nowIso, limit }) => {
    const due = await ctx.db
      .query('data_rows')
      .withIndex('by_scheduled_publish', (q) => q.lte('scheduled_publish_at', nowIso))
      .collect()
    return due
      .filter(
        (r) =>
          r.status === 'scheduled' &&
          r.deleted_at === null &&
          r.scheduled_publish_at !== null,
      )
      .sort((a, b) =>
        (a.scheduled_publish_at as string) < (b.scheduled_publish_at as string)
          ? -1
          : (a.scheduled_publish_at as string) > (b.scheduled_publish_at as string)
            ? 1
            : 0,
      )
      .slice(0, limit)
      .map((r) => ({
        rowId: r.id,
        tableId: r.table_id,
        scheduledPublishAt: r.scheduled_publish_at as string,
      }))
  },
})

// ---------------------------------------------------------------------------
// Bundle-import upserts (§4.6 — read-by-index → patch-or-insert)
// ---------------------------------------------------------------------------

const importFields = {
  id: v.string(),
  tableId: v.string(),
  cells: v.any(),
  slug: v.string(),
  status: statusValidator,
  publishedAt: v.union(v.null(), v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
}

/** Build the full insert payload for an imported row (user refs dropped). */
function importInsertDoc(args: {
  id: string
  tableId: string
  cells: unknown
  slug: string
  status: 'draft' | 'published' | 'unpublished' | 'scheduled'
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}) {
  return {
    id: args.id,
    table_id: args.tableId,
    cells_json: JSON.stringify(args.cells),
    slug: args.slug,
    status: args.status,
    active_version_id: null,
    author_user_id: null,
    created_by_user_id: null,
    updated_by_user_id: null,
    published_by_user_id: null,
    created_at: args.createdAt,
    updated_at: args.updatedAt,
    published_at: args.publishedAt,
    scheduled_publish_at: null,
    deleted_at: null,
    plugin_actor_id: null,
  } as const
}

/** Id-preserving upsert (merge-overwrite / replace import strategies). */
export const importUpsert = mutation({
  args: importFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await rowByAppId(ctx, args.id)
    if (existing) {
      await ctx.db.patch(existing._id, {
        table_id: args.tableId,
        cells_json: JSON.stringify(args.cells),
        slug: args.slug,
        status: args.status,
        published_at: args.publishedAt,
        updated_at: args.updatedAt,
      })
    } else {
      await ctx.db.insert('data_rows', importInsertDoc(args))
    }
    return null
  },
})

/**
 * Insert only when no constraint would be hit — skip if the id already exists
 * OR an active row in the same table already owns the (non-empty) slug. Mirrors
 * the SQL `on conflict do nothing` over the PK + the active-slug partial index.
 */
export const importInsertIfAbsent = mutation({
  args: importFields,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const existing = await rowByAppId(ctx, args.id)
    if (existing) return false
    if (args.slug) {
      const slugRows = await ctx.db
        .query('data_rows')
        .withIndex('by_table_slug', (q) => q.eq('table_id', args.tableId).eq('slug', args.slug))
        .collect()
      if (slugRows.some((r) => r.deleted_at === null)) return false
    }
    await ctx.db.insert('data_rows', importInsertDoc(args))
    return true
  },
})

/** Plain insert (the `replace` strategy already wiped the table). */
export const importReplace = mutation({
  args: importFields,
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('data_rows', importInsertDoc(args))
    return null
  },
})
