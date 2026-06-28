/**
 * Loop entity sources — the Convex read behind the built-in `data.rows` and
 * `site.media` loop sources (`src/core/loops/sources/*`).
 *
 * The loop sources live in `src/core` and must stay free of server-only
 * imports, so they reach their data through an injected adapter
 * (`@core/loops/dataAdapter`) that the Bun server fills with these queries
 * (`server/loops/adapter.ts`). The sources keep their LoopItem projection +
 * media-path resolution Bun-side — it depends on `@core` helpers that must not
 * run in Convex's V8 runtime — so these queries return the RAW joined rows.
 *
 * Joins mirror the old SQL:
 *   - post-type rows: `data_rows` (status='published', non-deleted) →
 *     `data_tables` (slug/route_base) → `data_row_versions` (the ACTIVE
 *     version's cells + published_at + version_number + published_by) →
 *     author/publisher users+roles. A published row whose active version is
 *     missing is dropped (the SQL inner join on `active_version_id`).
 *   - data-kind rows: `data_rows` read directly (no version workflow), joined
 *     to author user+role.
 *   - media: `media_assets`, `deleted_at is null`, optional mime-type prefix.
 *
 * Ordering + pagination happen here (the SQL `ORDER BY … LIMIT … OFFSET …`);
 * `total` is the full non-paginated count the loop's pager needs.
 */

import { v } from 'convex/values'
import { query, type QueryCtx } from './_generated/server'

const nullableString = v.union(v.null(), v.string())
const directionValidator = v.union(v.literal('asc'), v.literal('desc'))

const publishedRowValidator = v.object({
  version_id: v.string(),
  row_id: v.string(),
  table_id: v.string(),
  table_slug: v.string(),
  table_route_base: v.string(),
  version_number: v.number(),
  cells_json: v.record(v.string(), v.any()),
  slug: v.string(),
  author_user_id: nullableString,
  author_display_name: nullableString,
  author_role_slug: nullableString,
  author_role_name: nullableString,
  published_by_user_id: nullableString,
  published_by_display_name: nullableString,
  published_by_role_slug: nullableString,
  published_by_role_name: nullableString,
  published_at: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
})

const dataKindRowValidator = v.object({
  row_id: v.string(),
  table_id: v.string(),
  table_slug: v.string(),
  table_route_base: v.string(),
  cells_json: v.record(v.string(), v.any()),
  slug: v.string(),
  author_user_id: nullableString,
  author_display_name: nullableString,
  author_role_slug: nullableString,
  author_role_name: nullableString,
  created_at: v.string(),
  updated_at: v.string(),
})

const mediaRowValidator = v.object({
  id: v.string(),
  filename: v.string(),
  mime_type: v.string(),
  size_bytes: v.number(),
  public_path: v.string(),
  uploaded_by_user_id: nullableString,
  created_at: v.string(),
})

// ---------------------------------------------------------------------------
// User-ref hydration (the SQL `LEFT JOIN users LEFT JOIN roles`)
// ---------------------------------------------------------------------------

interface UserCols {
  display_name: string | null
  role_slug: string | null
  role_name: string | null
}

const EMPTY_USER_COLS: UserCols = { display_name: null, role_slug: null, role_name: null }

async function userCols(
  ctx: QueryCtx,
  userId: string | null,
  cache: Map<string, UserCols>,
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
      display_name: user.display_name,
      role_slug: role ? role.slug : null,
      role_name: role ? role.name : null,
    }
  }
  cache.set(userId, cols)
  return cols
}

function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ---------------------------------------------------------------------------
// data.rows source — published post-type rows OR direct data-kind rows
// ---------------------------------------------------------------------------

/**
 * One page of loop rows for `tableId`, dispatched by the table's `kind`:
 *   - `kind === ''`   → table missing or soft-deleted (empty result).
 *   - `kind === 'data'` → `dataRows` populated (read straight from `data_rows`).
 *   - otherwise (post-type) → `postRows` populated (active published version).
 *
 * `total` is the full count BEFORE pagination so the loop pager is accurate.
 */
export const dataRowLoop = query({
  args: {
    tableId: v.string(),
    orderBy: v.string(),
    direction: directionValidator,
    limit: v.number(),
    offset: v.number(),
  },
  returns: v.object({
    kind: v.string(),
    postRows: v.array(publishedRowValidator),
    dataRows: v.array(dataKindRowValidator),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    const table = await ctx.db
      .query('data_tables')
      .withIndex('by_app_id', (q) => q.eq('id', args.tableId))
      .unique()
    if (!table || table.deleted_at !== null) {
      return { kind: '', postRows: [], dataRows: [], total: 0 }
    }

    const dir = args.direction === 'asc' ? 1 : -1
    const cache = new Map<string, UserCols>()

    if (table.kind === 'data') {
      const rows = (
        await ctx.db
          .query('data_rows')
          .withIndex('by_table_updated', (q) => q.eq('table_id', args.tableId))
          .collect()
      ).filter((r) => r.deleted_at === null)

      const enriched = []
      for (const row of rows) {
        const author = await userCols(ctx, row.author_user_id, cache)
        enriched.push({
          row_id: row.id,
          table_id: row.table_id,
          table_slug: table.slug,
          table_route_base: table.route_base,
          cells_json: JSON.parse(row.cells_json) as Record<string, unknown>,
          slug: row.slug,
          author_user_id: row.author_user_id,
          author_display_name: author.display_name,
          author_role_slug: author.role_slug,
          author_role_name: author.role_name,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })
      }
      const key = args.orderBy === 'updatedAt' ? 'updated' : args.orderBy === 'slug' ? 'slug' : 'created'
      enriched.sort((x, y) => {
        const primary =
          key === 'updated'
            ? cmp(x.updated_at, y.updated_at)
            : key === 'slug'
              ? cmp(x.slug, y.slug)
              : cmp(x.created_at, y.created_at)
        return (primary !== 0 ? primary : cmp(x.row_id, y.row_id)) * dir
      })
      return {
        kind: table.kind,
        postRows: [],
        dataRows: enriched.slice(args.offset, args.offset + args.limit),
        total: enriched.length,
      }
    }

    // Post-type path: only published rows joined to their active version.
    const rows = (
      await ctx.db
        .query('data_rows')
        .withIndex('by_table_status_updated', (q) =>
          q.eq('table_id', args.tableId).eq('status', 'published'),
        )
        .collect()
    ).filter((r) => r.deleted_at === null)

    const enriched = []
    for (const row of rows) {
      if (!row.active_version_id) continue
      const version = await ctx.db
        .query('data_row_versions')
        .withIndex('by_app_id', (q) => q.eq('id', row.active_version_id as string))
        .unique()
      if (!version) continue
      const author = await userCols(ctx, row.author_user_id, cache)
      const publishedBy = await userCols(ctx, version.published_by_user_id, cache)
      enriched.push({
        version_id: version.id,
        row_id: row.id,
        table_id: row.table_id,
        table_slug: table.slug,
        table_route_base: table.route_base,
        version_number: version.version_number,
        cells_json: JSON.parse(version.cells_json) as Record<string, unknown>,
        slug: version.slug,
        author_user_id: row.author_user_id,
        author_display_name: author.display_name,
        author_role_slug: author.role_slug,
        author_role_name: author.role_name,
        published_by_user_id: version.published_by_user_id,
        published_by_display_name: publishedBy.display_name,
        published_by_role_slug: publishedBy.role_slug,
        published_by_role_name: publishedBy.role_name,
        published_at: version.published_at,
        created_at: version.created_at,
        updated_at: row.updated_at,
      })
    }
    enriched.sort((x, y) => {
      const primary =
        args.orderBy === 'createdAt'
          ? cmp(x.created_at, y.created_at)
          : args.orderBy === 'updatedAt'
            ? cmp(x.updated_at, y.updated_at)
            : args.orderBy === 'slug'
              ? cmp(x.slug, y.slug)
              : cmp(x.published_at, y.published_at)
      return (primary !== 0 ? primary : cmp(x.version_id, y.version_id)) * dir
    })
    return {
      kind: table.kind,
      postRows: enriched.slice(args.offset, args.offset + args.limit),
      dataRows: [],
      total: enriched.length,
    }
  },
})

/** Resolve a set of media-asset ids to their `public_path` (the SQL IN-list). */
export const mediaPaths = query({
  args: { ids: v.array(v.string()) },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, { ids }) => {
    const out: Record<string, string> = {}
    for (const id of new Set(ids)) {
      const asset = await ctx.db
        .query('media_assets')
        .withIndex('by_app_id', (q) => q.eq('id', id))
        .unique()
      if (asset) out[id] = asset.public_path
    }
    return out
  },
})

// ---------------------------------------------------------------------------
// site.media source — one page of media assets
// ---------------------------------------------------------------------------

export const mediaItems = query({
  args: {
    mimePrefix: v.string(),
    orderBy: v.string(),
    direction: directionValidator,
    limit: v.number(),
    offset: v.number(),
  },
  returns: v.object({ rows: v.array(mediaRowValidator), total: v.number() }),
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query('media_assets')
      .withIndex('by_deleted', (q) => q.eq('deleted_at', null))
      .collect()
    const filtered = args.mimePrefix
      ? all.filter((a) => a.mime_type.startsWith(args.mimePrefix))
      : all

    const dir = args.direction === 'asc' ? 1 : -1
    filtered.sort((x, y) => {
      const primary =
        args.orderBy === 'filename' ? cmp(x.filename, y.filename) : cmp(x.created_at, y.created_at)
      return (primary !== 0 ? primary : cmp(x.id, y.id)) * dir
    })

    return {
      total: filtered.length,
      rows: filtered.slice(args.offset, args.offset + args.limit).map((a) => ({
        id: a.id,
        filename: a.filename,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
        public_path: a.public_path,
        uploaded_by_user_id: a.uploaded_by_user_id,
        created_at: a.created_at,
      })),
    }
  },
})
