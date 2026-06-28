/**
 * Operator-object filter querying for the `api.cms.content.*` plugin surface.
 *
 *   listDataRowsWithFilter — list rows in a table with operator-object
 *                            filters, sort, and pagination
 *
 * Convex port: Convex has no `json_extract`, so the filtering happens in
 * `convex/dataRows.listWithFilter`, which fetches the table's candidate rows by
 * index, parses `cells_json`, and applies the eq/ne/gt/gte/lt/lte/in/like
 * operators in JS (§4.2). This adapter keeps the field-name validation (the
 * same identifier rule the old SQL splice relied on) so an invalid filter /
 * orderBy key still throws before the query runs, then maps the joined rows
 * through `mapRow`.
 */
import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import type { StorageFilterValue } from '@core/plugin-sdk/storageSchemas'
import { api, getConvex } from '../../../convex/client'
import { mapRow } from './mapper'

/**
 * Options accepted by `listDataRowsWithFilter`. Mirrors the plugin SDK's
 * StorageListOptions shape (operator-object filter, asc/desc orderBy,
 * limit/offset) plus a status filter scoped to the row's lifecycle.
 *
 * `filter` keys are top-level JSON paths under `cells_json` (e.g. `title`,
 * `featuredMedia`). The repository validates each key against an identifier
 * regex before delegating.
 *
 * `orderBy` accepts JSON-cell paths AND the four row-level columns
 * `slug` / `status` / `created_at` / `updated_at` / `published_at`.
 */
interface ListDataRowsFilterOptions {
  filter?: Record<string, StorageFilterValue>
  orderBy?: Record<string, 'asc' | 'desc'>
  status?: 'any' | 'draft' | 'published' | 'scheduled'
  limit?: number
  offset?: number
}

interface ListDataRowsWithFilterResult {
  rows: DataRow[]
  totalCount: number
}

/** Identifier regex — the same rule the old `jsonField` SQL splice used. */
const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Row-level columns plugins are allowed to order by directly. */
const ROW_LEVEL_ORDER_KEYS = new Set([
  'slug',
  'status',
  'created_at',
  'updated_at',
  'published_at',
])

export async function listDataRowsWithFilter(
  _db: DbClient,
  tableId: string,
  options: ListDataRowsFilterOptions = {},
): Promise<ListDataRowsWithFilterResult> {
  const { filter, orderBy, status = 'any', limit = 100, offset = 0 } = options

  if (filter) {
    for (const key of Object.keys(filter)) {
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid filter field name: ${JSON.stringify(key)}`)
      }
    }
  }
  if (orderBy) {
    for (const key of Object.keys(orderBy)) {
      if (ROW_LEVEL_ORDER_KEYS.has(key)) continue
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid orderBy field name: ${JSON.stringify(key)}`)
      }
    }
  }

  const { rows, totalCount } = await getConvex().query(api.dataRows.listWithFilter, {
    tableId,
    filter,
    orderBy,
    status,
    limit,
    offset,
  })
  return { rows: rows.map(mapRow), totalCount }
}
