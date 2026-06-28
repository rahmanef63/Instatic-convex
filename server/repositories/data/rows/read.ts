/**
 * Hydrated read queries for data rows.
 *
 *   listDataRows          — non-deleted rows in a table, optionally restricted
 *                           to rows owned by the calling user
 *   listDataRowIdSlugs    — lightweight (id, slug) projection of a table's rows
 *   getDataRow            — a single hydrated row (the canonical re-read every
 *                           mutation funnels through)
 *   getDataRowMany        — many hydrated rows by id
 *   getDataRowBySlug      — a single row by its denormalized slug
 *   countDataRows         — non-deleted row count for a table
 *   listDataAuthorOptions — active users for the author picker
 *
 * Convex port: these are thin adapters over `convex/dataRows.ts`. The signatures
 * are frozen — the leading SQL `DbClient` handle is retained (named `_db`,
 * intentionally unused) so callers keep invoking these unchanged; it is dropped
 * when `server/db/*` is retired. Hydration of the four user refs runs through
 * `mapRow` (→ the shared `userRefAt`) over the joined rows Convex returns.
 */
import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import { api, getConvex } from '../../../convex/client'
import { mapRow, isOwnedByUser } from './mapper'

interface ListDataRowsVisibility {
  /**
   * When set, only rows whose effective owner is this user id are returned.
   * Ownership: author overrides; when no author is assigned the creator is
   * the effective owner.
   */
  ownerUserId?: string | null
}

export async function listDataRows(
  _db: DbClient,
  tableId: string,
  visibility: ListDataRowsVisibility = {},
): Promise<DataRow[]> {
  const rows = await getConvex().query(api.dataRows.list, { tableId })
  const dataRows = rows.map(mapRow)
  if (visibility.ownerUserId) {
    const ownerUserId = visibility.ownerUserId
    return dataRows.filter((row) => isOwnedByUser(row, ownerUserId))
  }
  return dataRows
}

interface DataRowIdSlug {
  id: string
  slug: string
}

/**
 * Lightweight (id, slug) projection of a table's non-deleted rows. The roster
 * reconcilers need exactly this — the reap diff and the cross-row
 * slug-uniqueness check — without paying the hydrated read's full parse per row.
 */
export async function listDataRowIdSlugs(
  _db: DbClient,
  tableId: string,
): Promise<DataRowIdSlug[]> {
  return getConvex().query(api.dataRows.listIdSlugs, { tableId })
}

export async function getDataRow(_db: DbClient, rowId: string): Promise<DataRow | null> {
  const row = await getConvex().query(api.dataRows.getById, { rowId })
  return row ? mapRow(row) : null
}

/**
 * Read many non-deleted hydrated rows by id. Rows come back in no particular
 * order — callers index them by id; an id absent from the result is missing or
 * soft-deleted.
 */
export async function getDataRowMany(
  _db: DbClient,
  rowIds: ReadonlyArray<string>,
): Promise<DataRow[]> {
  if (rowIds.length === 0) return []
  const rows = await getConvex().query(api.dataRows.getMany, { rowIds: [...rowIds] })
  return rows.map(mapRow)
}

/** Read a non-deleted row in a table by its denormalized slug. */
export async function getDataRowBySlug(
  _db: DbClient,
  tableId: string,
  slug: string,
): Promise<DataRow | null> {
  const row = await getConvex().query(api.dataRows.getBySlug, { tableId, slug })
  return row ? mapRow(row) : null
}

/** Count non-deleted rows in a table. */
export async function countDataRows(_db: DbClient, tableId: string): Promise<number> {
  return getConvex().query(api.dataRows.count, { tableId })
}

export async function listDataAuthorOptions(
  _db: DbClient,
): Promise<Array<{ id: string; email: string; displayName: string; roleSlug: string | null; roleName: string | null }>> {
  return getConvex().query(api.dataRows.listAuthorOptions, {})
}
