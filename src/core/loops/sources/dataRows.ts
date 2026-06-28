/**
 * Built-in `data.rows` loop source — iterates published data rows from a
 * data table (post-type or generic data-kind).
 *
 * Reads from `data_row_versions` joined to `data_rows`, `data_tables`, and
 * user/role tables, scoped to rows with `status = 'published'`. Featured
 * media resolution is handled in app code (not SQL) so the query stays
 * dialect-naive: after fetching the page of rows, a single batch query
 * resolves all unique media ids to their `public_path`.
 *
 * Order options:
 *   - publishedAt — most natural for post-type listings
 *   - createdAt   — first authored
 *   - updatedAt   — last modified
 *   - slug        — alphabetical by slug (closest dialect-neutral proxy for
 *                   title, which lives inside cells_json)
 *
 * Filters:
 *   - tableId (required) — the data table to iterate
 */

import type { LoopEntitySource, LoopFetchResult, LoopItem } from '@core/loops/types'
import {
  getLoopDataAdapter,
  type DataKindRowRecord,
  type PublishedDataRowRecord,
} from '@core/loops/dataAdapter'
import { isoDate } from '../../utils/isoDate'
import { firstImagePathFromMarkdown } from '@core/markdown/renderMarkdown'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { publicDataUserFromParts } from '@core/data/publicDataUser'
import { readFeaturedMediaCell } from '@core/data/cells'
import type { DataRowCells } from '@core/data/schemas'

type OrderColumn = 'publishedAt' | 'createdAt' | 'updatedAt' | 'slug'

const ALLOWED_ORDER_BY: ReadonlySet<OrderColumn> = new Set([
  'publishedAt',
  'createdAt',
  'updatedAt',
  'slug',
])

// ---------------------------------------------------------------------------
// Media path resolution
//
// Featured media lives inside cells_json, not as a column. We extract the
// media id from each row's cells in TypeScript, deduplicate the set, and
// resolve all unique ids through the adapter in one round trip — regardless of
// how many rows the page slice returned.
// ---------------------------------------------------------------------------

function extractFeaturedMediaIds(rows: Array<{ cells_json: Record<string, unknown> }>): string[] {
  const ids: string[] = []
  for (const row of rows) {
    const id = readFeaturedMediaCell(row.cells_json as DataRowCells)
    if (id) ids.push(id)
  }
  return ids
}

// ---------------------------------------------------------------------------
// Row → LoopItem projection
// ---------------------------------------------------------------------------

function rowToLoopItem(
  row: PublishedDataRowRecord,
  mediaPathMap: Map<string, string>,
): LoopItem {
  const cells = row.cells_json as DataRowCells
  const tableRouteBase = normalizeRouteBase(row.table_route_base || `/${row.table_slug}`)
  const permalink = `${tableRouteBase === '/' ? '' : tableRouteBase}/${row.slug}`

  // Extract first inline image from the `body` cell (post-type rows only).
  const bodyValue = cells['body']
  const firstImagePath = typeof bodyValue === 'string'
    ? firstImagePathFromMarkdown(bodyValue)
    : null

  const featuredMediaId = readFeaturedMediaCell(cells)
  const featuredMediaPath = featuredMediaId ? (mediaPathMap.get(featuredMediaId) ?? null) : null

  const author = publicDataUserFromParts(
    row.author_display_name,
    row.author_role_slug,
    row.author_role_name,
  )
  const publishedBy = publicDataUserFromParts(
    row.published_by_display_name,
    row.published_by_role_slug,
    row.published_by_role_name,
  )

  return {
    id: row.row_id,
    fields: {
      // Cells — all user-defined fields accessible by fieldId
      ...cells,
      // System identity (overlay after cells so these are never shadowed)
      id: row.row_id,
      rowId: row.row_id,
      versionId: row.version_id,
      versionNumber: Number(row.version_number),
      tableId: row.table_id,
      tableSlug: row.table_slug,
      // People
      author,
      authorName: author?.displayName ?? null,
      authorRoleSlug: author?.roleSlug ?? null,
      authorRoleName: author?.roleName ?? null,
      publishedBy,
      publishedByName: publishedBy?.displayName ?? null,
      publishedByRoleSlug: publishedBy?.roleSlug ?? null,
      publishedByRoleName: publishedBy?.roleName ?? null,
      // Media aliases
      featuredMediaId,
      featuredMedia: featuredMediaPath,
      featuredMediaPath,
      featuredMediaUrl: featuredMediaPath,
      firstImage: firstImagePath,
      firstImagePath,
      firstImageUrl: firstImagePath,
      // Dates / routing
      slug: row.slug,
      publishedAt: isoDate(row.published_at),
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
      permalink,
    },
  }
}

// ---------------------------------------------------------------------------
// Data-kind page-slice query
//
// Data-kind tables (`kind: 'data'`) have no publish lifecycle and no
// `data_row_versions` rows. They are authored directly via the Data
// admin grid: cells live on `data_rows.cells_json`, and the row is
// "live" the moment it's created. Iterating them through the same
// published-version join the post-type path uses would silently return
// zero rows — which is exactly the "Lorem ipsum forever" bug authors
// were hitting in the canvas. So we query `data_rows` directly here.
// ---------------------------------------------------------------------------

function dataKindRowToLoopItem(
  row: DataKindRowRecord,
  mediaPathMap: Map<string, string>,
): LoopItem {
  const cells = row.cells_json as DataRowCells
  const tableRouteBase = normalizeRouteBase(row.table_route_base || `/${row.table_slug}`)
  const permalink = `${tableRouteBase === '/' ? '' : tableRouteBase}/${row.slug}`

  const featuredMediaId = readFeaturedMediaCell(cells)
  const featuredMediaPath = featuredMediaId ? (mediaPathMap.get(featuredMediaId) ?? null) : null

  const author = publicDataUserFromParts(
    row.author_display_name,
    row.author_role_slug,
    row.author_role_name,
  )

  return {
    id: row.row_id,
    fields: {
      ...cells,
      id: row.row_id,
      rowId: row.row_id,
      tableId: row.table_id,
      tableSlug: row.table_slug,
      author,
      authorName: author?.displayName ?? null,
      authorRoleSlug: author?.roleSlug ?? null,
      authorRoleName: author?.roleName ?? null,
      publishedBy: null,
      publishedByName: null,
      publishedByRoleSlug: null,
      publishedByRoleName: null,
      featuredMediaId,
      featuredMedia: featuredMediaPath,
      featuredMediaPath,
      featuredMediaUrl: featuredMediaPath,
      firstImage: null,
      firstImagePath: null,
      firstImageUrl: null,
      slug: row.slug,
      // Data-kind rows have no publishedAt — use createdAt as a proxy so
      // ordering / display stays consistent across both kinds.
      publishedAt: isoDate(row.created_at),
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
      permalink,
    },
  }
}

// ---------------------------------------------------------------------------
// Reusable fetch helper
//
// Shared by the publisher (`DataRowsSource.fetch`) and the admin loop-preview
// endpoint so both return the same LoopItem projection. The Convex
// `dataRowLoop` query does the join + ordering + pagination and dispatches by
// table kind (post-type → active published version; data-kind → `data_rows`
// directly); featured-media paths are resolved here in one extra round trip.
// ---------------------------------------------------------------------------

export async function fetchPublishedDataRowItems(opts: {
  tableId: string
  orderBy: string
  direction: 'asc' | 'desc'
  limit: number
  offset: number
}): Promise<LoopFetchResult> {
  if (!opts.tableId) return { items: [], totalItems: 0 }

  const orderBy: OrderColumn = ALLOWED_ORDER_BY.has(opts.orderBy as OrderColumn)
    ? (opts.orderBy as OrderColumn)
    : 'publishedAt'
  const direction: 'asc' | 'desc' = opts.direction === 'asc' ? 'asc' : 'desc'

  const adapter = getLoopDataAdapter()
  const page = await adapter.dataRowLoop({
    tableId: opts.tableId,
    orderBy,
    direction,
    limit: opts.limit,
    offset: opts.offset,
  })
  if (page.kind === '' || page.total === 0) return { items: [], totalItems: 0 }

  const rows = page.kind === 'data' ? page.dataRows : page.postRows
  const mediaPathMap = new Map(
    Object.entries(await adapter.resolveMediaPaths(extractFeaturedMediaIds(rows))),
  )
  const items =
    page.kind === 'data'
      ? page.dataRows.map((row) => dataKindRowToLoopItem(row, mediaPathMap))
      : page.postRows.map((row) => rowToLoopItem(row, mediaPathMap))
  return { items, totalItems: page.total }
}

// ---------------------------------------------------------------------------
// Source export
// ---------------------------------------------------------------------------

export const DataRowsSource: LoopEntitySource = {
  id: 'data.rows',
  label: 'Data rows',
  description: 'Loop published rows in a data table (posts, products, etc.).',

  filterSchema: {
    tableId: {
      type: 'select',
      label: 'Table',
      // Options are populated dynamically by the Properties Panel from the
      // available data tables — passing an empty list here keeps the schema
      // valid when the source is registered before the table list is loaded.
      options: [],
    },
  },

  orderByOptions: [
    { id: 'publishedAt', label: 'Published date' },
    { id: 'createdAt', label: 'Created date' },
    { id: 'updatedAt', label: 'Last updated' },
    { id: 'slug', label: 'Slug (A–Z)' },
  ],

  fields: [
    { id: 'slug', label: 'Slug' },
    { id: 'title', label: 'Title (post-type)' },
    { id: 'authorName', label: 'Author name' },
    { id: 'authorRoleName', label: 'Author role' },
    { id: 'body', label: 'Body (post-type, markdown)', format: 'html' },
    { id: 'featuredMedia', label: 'Featured media (post-type)', format: 'media' },
    { id: 'firstImage', label: 'First inline image', format: 'media' },
    { id: 'seoTitle', label: 'SEO title (post-type)' },
    { id: 'seoDescription', label: 'SEO description (post-type)' },
    { id: 'permalink', label: 'Permalink', format: 'url' },
    { id: 'publishedAt', label: 'Published date' },
    { id: 'publishedByName', label: 'Published by' },
    { id: 'publishedByRoleName', label: 'Publisher role' },
    { id: 'createdAt', label: 'Created date' },
    { id: 'updatedAt', label: 'Updated date' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    return fetchPublishedDataRowItems({
      tableId: typeof ctx.filters.tableId === 'string' ? ctx.filters.tableId : '',
      orderBy: ctx.orderBy,
      direction: ctx.direction,
      limit: ctx.limit,
      offset: ctx.offset,
    })
  },

  preview() {
    // Editor-side preview is handled by the canvas via `useLoopPreviewItems`:
    // it first calls the admin endpoint `/data/tables/:id/loop-preview` to
    // fetch real published rows via `fetchPublishedDataRowItems` (this file),
    // and falls back to synthetic preview items from `dataTablePreviewToLoopItem`
    // when there are no published rows. This source's synchronous `preview()`
    // returns [] so no synthetic placeholder data leaks from the server source.
    return []
  },
}
