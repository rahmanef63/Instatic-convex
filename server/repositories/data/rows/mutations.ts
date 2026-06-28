/**
 * Single-row write mutations for data rows.
 *
 *   createDataRow        — insert a new draft
 *   saveDataRowDraft     — overwrite the draft cells and slug
 *   updateDataRowDraftCells — the write half of saveDataRowDraft, no re-read
 *   softDeleteDataRow    — set deleted_at
 *   updateDataRowTable   — move a row to another table (rejects on slug conflict)
 *   updateDataRowStatus  — flip between draft / unpublished
 *   updateDataRowAuthor  — reassign the author user id
 *
 * Convex port: thin adapters over `convex/dataRows.ts`. Each hydrated read/write
 * returns a joined row that `mapRow` (→ the shared `userRefAt`) turns into a
 * `DataRow`. Soft-delete is
 * the exception: it returns the narrow `DeletedRowSummary` directly (a
 * soft-deleted row carries no hydrated user refs).
 *
 * The public render-cache bump (`bumpPublishVersionSerialized`) stays on the
 * Bun side and runs AFTER the Convex mutation — it touches the server's
 * in-memory publish state, not the database.
 */
import type { DataRow, DeletedRowSummary } from '@core/data/schemas'
import { bumpPublishVersionSerialized } from '../../../publish/publishState'
import { api, getConvex } from '../../../convex/client'
import { mapRow, type InsertDataRowInput, type UpdateDataRowDraftInput } from './mapper'

type UpdateDataRowTableResult =
  | { ok: true; row: DataRow }
  | { ok: false; reason: 'row_not_found' | 'table_not_found' | 'slug_conflict' }

export async function createDataRow(
  input: InsertDataRowInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow> {
  const row = await getConvex().mutation(api.dataRows.create, {
    id: input.id,
    tableId: input.tableId,
    cells: input.cells,
    slug: input.slug,
    actorUserId,
    pluginActorId,
  })
  if (!row) throw new Error('data row was created but could not be re-read')
  return mapRow(row)
}

export async function saveDataRowDraft(
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow | null> {
  const row = await getConvex().mutation(api.dataRows.saveDraft, {
    rowId,
    cells: input.cells,
    slug: input.slug,
    actorUserId,
    pluginActorId,
  })
  return row ? mapRow(row) : null
}

/**
 * The write half of `saveDataRowDraft`, without the hydrated re-read. The
 * roster reconcilers discard the row anyway. Returns whether a (non-deleted)
 * row matched.
 */
export async function updateDataRowDraftCells(
  rowId: string,
  input: UpdateDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<boolean> {
  return getConvex().mutation(api.dataRows.updateDraftCells, {
    rowId,
    cells: input.cells,
    slug: input.slug,
    actorUserId,
    pluginActorId,
  })
}

/**
 * Soft-delete returns the narrow `DeletedRowSummary` (id / tableId / slug /
 * status / deletedAt) — all the soft-delete callers consume (audit logging +
 * artefact pruning). A soft-deleted row carries no user-ref joins, so it cannot
 * be a hydrated `DataRow`.
 */
export async function softDeleteDataRow(
  rowId: string,
  actorUserId: string | null = null,
): Promise<DeletedRowSummary | null> {
  return getConvex().mutation(api.dataRows.softDelete, { rowId, actorUserId })
}

/**
 * Move a row to another table. Refuses if the target table is missing or
 * already has a non-deleted row with the same (non-empty) slug. Returns a
 * discriminated union so handlers can map each failure mode to the right HTTP
 * status. Moving a published row changes its public route, so the render cache
 * is invalidated AFTER the move commits.
 */
export async function updateDataRowTable(
  rowId: string,
  tableId: string,
  actorUserId: string | null = null,
): Promise<UpdateDataRowTableResult> {
  const result = await getConvex().mutation(api.dataRows.updateTable, {
    rowId,
    tableId,
    actorUserId,
  })
  if (!result.ok) return { ok: false, reason: result.reason }
  if (result.wasPublished) await bumpPublishVersionSerialized()
  return { ok: true, row: mapRow(result.row) }
}

/**
 * Flip a row between `draft` and `unpublished` (the only states reachable
 * from this endpoint — `published` goes through the dedicated publish flow).
 * Always clears publish and schedule metadata.
 */
export async function updateDataRowStatus(
  rowId: string,
  status: 'draft' | 'unpublished',
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const row = await getConvex().mutation(api.dataRows.updateStatus, {
    rowId,
    status,
    actorUserId,
  })
  if (!row) return null
  // Invalidate the render cache — the route's published state changed.
  await bumpPublishVersionSerialized()
  return mapRow(row)
}

export async function updateDataRowAuthor(
  rowId: string,
  authorUserId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const row = await getConvex().mutation(api.dataRows.updateAuthor, {
    rowId,
    authorUserId,
    actorUserId,
  })
  return row ? mapRow(row) : null
}
