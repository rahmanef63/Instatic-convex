/**
 * Bundle-import upserts for data rows. These bypass the normal CRUD path to
 * preserve the source instance's original id, status, and timestamps.
 *
 *   upsertDataRow         — id-preserving upsert (merge-overwrite / replace)
 *   insertDataRowIfAbsent — insert only if id absent (merge-add)
 *   replaceDataRow        — plain insert after wipe (replace strategy)
 *
 * User reference columns (author, createdBy, etc.) are intentionally dropped on
 * import: the user ids from the source instance will not exist in the target.
 *
 * Convex port: thin adapters over `convex/dataRows.ts`. Convex has no
 * `ON CONFLICT`, so each upsert is a read-by-index → patch-or-insert inside one
 * atomic mutation (§4.6). The created/updated timestamp defaults are computed
 * here, exactly as before.
 */
import type { DataRowCells, DataRowStatus } from '@core/data/schemas'
import { api, getConvex } from '../../../convex/client'

export interface DataRowImportInput {
  id: string
  tableId: string
  cells: DataRowCells
  slug: string
  status: DataRowStatus
  publishedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

function importArgs(input: DataRowImportInput) {
  const now = new Date().toISOString()
  return {
    id: input.id,
    tableId: input.tableId,
    cells: input.cells,
    slug: input.slug,
    status: input.status,
    publishedAt: input.publishedAt,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  }
}

/**
 * Upsert a row preserving its original id, status, and timestamps. Used by the
 * `merge-overwrite` and `replace` import strategies.
 */
export async function upsertDataRow(input: DataRowImportInput): Promise<void> {
  await getConvex().mutation(api.dataRows.importUpsert, importArgs(input))
}

/**
 * Insert a row only when no uniqueness constraint is hit. Returns `true` when
 * the row was inserted, `false` when it was skipped (id conflict, or an active
 * row in the same table already owns the imported slug). Used by the
 * `merge-add` import strategy.
 */
export async function insertDataRowIfAbsent(
  input: DataRowImportInput,
): Promise<boolean> {
  return getConvex().mutation(api.dataRows.importInsertIfAbsent, importArgs(input))
}

/**
 * Plain insert with no conflict handling. Assumes the caller has already wiped
 * the table (as the `replace` strategy does).
 */
export async function replaceDataRow(input: DataRowImportInput): Promise<void> {
  await getConvex().mutation(api.dataRows.importReplace, importArgs(input))
}
