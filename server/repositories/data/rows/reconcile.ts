/**
 * Roster reconcile — the shared write path behind the editor's incremental
 * saves (PUT /pages, /components, /layouts). One atomic Convex mutation
 * (`convex/dataRows.reconcileRoster`) that makes storage match the client's
 * roster: write the changed rows, soft-delete the dropped ones
 * (docs/CONVEX-MIGRATION.md §3 #9).
 *
 * The load-bearing statement order is preserved inside that mutation:
 *
 *   1. Reap FIRST. A changed row may take the slug of a row this same request
 *      deletes (homepage swap + delete of the old homepage in one batch); the
 *      soft-delete frees the slug before any write needs it.
 *   2. Two-phase slug writes. Two changed rows may SWAP slugs (A↔B); rows whose
 *      slug changes are parked on the empty slug together with their cells,
 *      then all final slugs land in a second pass once every old slug is free.
 *
 * A write whose id matches a SOFT-DELETED row revives that row instead of
 * inserting (undo of a delete re-submits the page with its original id).
 *
 * Convex port: a thin adapter. `rowsToReap` stays here as the pure reap
 * predicate (the Convex mutation reimplements the same logic inline, since it
 * cannot import this server module).
 */
import { api, getConvex } from '../../../convex/client'

/**
 * Decide which existing rows to soft-delete during a roster reconcile.
 *
 * With `baselineIds` (the row ids the saving client loaded), only reap a row
 * the client knew about and dropped — never a row another session created
 * concurrently, which the saving client never saw (ISS-041). With no baseline,
 * reap every row missing from the incoming set (authoritative full replace).
 */
export function rowsToReap(
  existingIds: Iterable<string>,
  incomingIds: ReadonlySet<string>,
  baselineIds?: ReadonlySet<string>,
): string[] {
  return [...existingIds].filter(
    (id) => !incomingIds.has(id) && (baselineIds ? baselineIds.has(id) : true),
  )
}

export interface RowRosterWrite {
  id: string
  cells: Record<string, unknown>
  slug: string
}

export interface ReconcileRowRosterInput {
  tableId: string
  /** The changed rows to create/update, with their final slugs. */
  writes: RowRosterWrite[]
  /** The client's FULL row-id roster — rows missing from it are reaped. */
  keepIds: ReadonlySet<string>
  /** Optimistic-concurrency baseline (ISS-041); absent = full replace. */
  baselineIds?: ReadonlySet<string>
  actorUserId: string
}

/**
 * Reconcile a table's rows to the client's roster in one atomic mutation.
 * Returns whether any reaped row was published — callers that own public
 * routes (pages) bump the publish version AFTER the mutation commits.
 */
export async function reconcileDataRowRoster(
  { tableId, writes, keepIds, baselineIds, actorUserId }: ReconcileRowRosterInput,
): Promise<{ reapedPublished: boolean }> {
  return getConvex().mutation(api.dataRows.reconcileRoster, {
    tableId,
    writes: writes.map((w) => ({ id: w.id, cells: w.cells, slug: w.slug })),
    keepIds: [...keepIds],
    baselineIds: baselineIds ? [...baselineIds] : undefined,
    actorUserId,
  })
}
