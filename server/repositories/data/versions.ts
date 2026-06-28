/**
 * Shared version-number allocation for `data_row_versions`.
 *
 * Every new version of a data row — whether written by the per-row publish
 * path (`data/publish.ts`) or the whole-site publish pipeline
 * (`repositories/publish.ts`) — allocates its `version_number` through this
 * single function so the "next = max(existing) + 1" invariant has one home.
 *
 * Convex port: this is now a thin adapter over `convex/dataTables.ts`
 * (docs/CONVEX-MIGRATION.md §2). The atomic publish flow allocates + inserts
 * versions inside its own mutation; this standalone allocator serves the
 * non-atomic callers.
 *
 * @see convex/dataTables.ts — the `nextVersionNumber` query
 */

import { api, getConvex } from '../../convex/client'

/**
 * Next `version_number` for a row: `max(existing) + 1`, or `1` when the row has
 * no versions yet.
 */
export async function nextDataRowVersionNumber(rowId: string): Promise<number> {
  return getConvex().query(api.dataTables.nextVersionNumber, { rowId })
}
