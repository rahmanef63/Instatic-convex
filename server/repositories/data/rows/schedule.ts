/**
 * Scheduled-publish lifecycle for data rows.
 *
 *   scheduleDataRowPublish   — mark a row `scheduled` for a future publish
 *   cancelScheduledPublish   — revert a pending scheduled row to a draft
 *   listDuePublishSchedules  — read scheduled rows whose target time has passed
 *
 * The publish-scheduler tick (`server/publish/publishScheduler.ts`) polls
 * `listDuePublishSchedules` and calls the regular publish path on each result.
 *
 * Convex port: thin adapters over `convex/dataRows.ts`. The two mutations return
 * a joined row that `mapRow` turns into a `DataRow`.
 */
import type { DataRow } from '@core/data/schemas'
import { api, getConvex } from '../../../convex/client'
import { mapRow } from './mapper'

/**
 * Mark a row as `scheduled` for future publication. `whenIso` MUST be in the
 * future — the caller (HTTP handler) validates this; we don't re-validate so a
 * direct repo caller (tests, fixtures) can plant rows at any time.
 * `published_at` / `published_by_user_id` are cleared (repopulated when the
 * tick actually publishes the row).
 */
export async function scheduleDataRowPublish(
  rowId: string,
  whenIso: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const row = await getConvex().mutation(api.dataRows.schedulePublish, {
    rowId,
    whenIso,
    actorUserId,
  })
  return row ? mapRow(row) : null
}

/**
 * Cancel a pending scheduled publication and revert the row to a draft. Used by
 * the "Cancel schedule" UI action and by the publish-scheduler tick's failure
 * handler (a failed publish attempt falls back to draft).
 */
export async function cancelScheduledPublish(
  rowId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const row = await getConvex().mutation(api.dataRows.cancelScheduledPublish, {
    rowId,
    actorUserId,
  })
  return row ? mapRow(row) : null
}

/** Lightweight read shape for the publish-scheduler tick. */
interface DueScheduledRow {
  rowId: string
  tableId: string
  scheduledPublishAt: string
}

/**
 * List scheduled rows whose target time has passed and that aren't already
 * deleted. Returns up to `limit` rows ordered by their target time (oldest
 * first). The scheduler tick calls this, then calls `publishDataRow(...)` on
 * each result.
 *
 * NOT atomic — two concurrent leader instances could read the same batch. The
 * publish-scheduler tick relies on the host-level leader lock to ensure only
 * one instance ticks at a time.
 */
export async function listDuePublishSchedules(
  nowIso: string,
  limit: number,
): Promise<DueScheduledRow[]> {
  return getConvex().query(api.dataRows.listDuePublishSchedules, { nowIso, limit })
}
