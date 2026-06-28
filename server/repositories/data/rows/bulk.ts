/**
 * Batch operations for data rows. Each helper collapses the matching loop into
 * ONE atomic Convex mutation (Convex mutations are atomic over every document
 * they touch — a failure mid-loop rolls the whole mutation back), replacing the
 * old `db.transaction(...)` blocks (docs/CONVEX-MIGRATION.md §3 #10–12).
 *
 *   createDataRowMany     — bulk-insert N draft rows
 *   saveDataRowDraftMany  — bulk-update N rows' draft cells + slug
 *   softDeleteDataRowMany — bulk-soft-delete N rows
 *
 * Convex port: thin adapters. Signatures are frozen — the leading SQL
 * `DbClient` handle is retained (named `_db`, intentionally unused).
 */
import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import { api, getConvex } from '../../../convex/client'
import { mapRow, type InsertDataRowInput, type UpdateDataRowDraftInput } from './mapper'

/**
 * Bulk-insert N draft rows atomically. Used by
 * `api.cms.content.table(slug).createMany(...)` — one slug conflict / error
 * aborts the entire batch (the whole mutation rolls back).
 */
export async function createDataRowMany(
  _db: DbClient,
  inputs: ReadonlyArray<InsertDataRowInput>,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow[]> {
  const rows = await getConvex().mutation(api.dataRows.createMany, {
    inputs: inputs.map((input) => ({
      id: input.id,
      tableId: input.tableId,
      cells: input.cells,
      slug: input.slug,
    })),
    actorUserId,
    pluginActorId,
  })
  return rows.map(mapRow)
}

/**
 * Bulk-update N rows atomically. Each update overrides the row's draft cells
 * AND slug — the caller pre-computes the denormalized slug exactly as the
 * per-row handler does.
 */
export async function saveDataRowDraftMany(
  _db: DbClient,
  updates: ReadonlyArray<{ id: string; input: UpdateDataRowDraftInput }>,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow[]> {
  const rows = await getConvex().mutation(api.dataRows.saveDraftMany, {
    updates: updates.map(({ id, input }) => ({ id, cells: input.cells, slug: input.slug })),
    actorUserId,
    pluginActorId,
  })
  return rows.map(mapRow)
}

/**
 * Bulk-soft-delete N rows atomically. Returns the number of rows actually
 * deleted (skipping rows already missing / soft-deleted), plus how many were
 * `published` — callers use that to invalidate the public render cache AFTER
 * the mutation commits (the bump must never run inside it; it serializes on the
 * publish lock).
 */
export async function softDeleteDataRowMany(
  _db: DbClient,
  rowIds: ReadonlyArray<string>,
  actorUserId: string | null = null,
): Promise<{ deleted: number; publishedDeleted: number }> {
  return getConvex().mutation(api.dataRows.softDeleteMany, {
    rowIds: [...rowIds],
    actorUserId,
  })
}
