/**
 * Cross-table content search (spotlight content provider).
 *
 *   searchDataRows — search non-deleted rows across all non-deleted data
 *                    tables by slug, returning a lightweight summary
 *
 * Convex port: a thin adapter over `convex/dataRows.search`, which scans the
 * rows and JS-substring-matches the slug (§4.3 — there is no denormalized
 * search text to back a `.searchIndex`). The slug is a URL-safe, lowercased
 * derivative of the content title, a reliable text proxy without dialect-
 * specific JSON extraction. The effective-owner visibility filter stays here.
 */
import type { DbClient } from '../../../db/client'
import type { DataRowStatus } from '@core/data/schemas'
import { api, getConvex } from '../../../convex/client'

/**
 * A lightweight row summary returned by spotlight content search.
 * Omits user references and cells to keep the response small.
 */
interface DataRowSearchResult {
  id: string
  tableId: string
  tableSlug: string
  tableName: string
  slug: string
  status: DataRowStatus
  updatedAt: string
}

interface SearchDataRowsVisibility {
  /**
   * When set, only rows whose effective owner matches this user id are
   * returned. Ownership follows the same rule used by `listDataRows`:
   * `authorUserId` wins when present, otherwise `createdByUserId` is the
   * effective owner. Pass `null` (or omit) for callers who can see every
   * row (`content.edit.any` / `content.publish.any` / `content.manage`).
   */
  ownerUserId?: string | null
}

export async function searchDataRows(
  _db: DbClient,
  query: string,
  limit: number,
  visibility: SearchDataRowsVisibility = {},
): Promise<DataRowSearchResult[]> {
  const rows = await getConvex().query(api.dataRows.search, { query, limit })
  const visible = visibility.ownerUserId
    ? rows.filter((row) => {
        const ownerUserId = visibility.ownerUserId
        if (row.authorUserId === ownerUserId) return true
        if (row.authorUserId === null) return row.createdByUserId === ownerUserId
        return false
      })
    : rows
  return visible.map((row) => ({
    id: row.id,
    tableId: row.tableId,
    tableSlug: row.tableSlug,
    tableName: row.tableName,
    slug: row.slug,
    status: row.status,
    updatedAt: row.updatedAt,
  }))
}
