/**
 * Centralised emit helpers for the `content.entry.*` plugin event channel.
 *
 * Every code path that creates / updates / deletes a `data_row` should fire
 * the matching event so plugin listeners (SEO assistants, translators, search
 * indexers, etc.) can react. The payload carries an `actor` field so plugins
 * can avoid feedback loops on their own writes.
 *
 * Repository functions stay pure (no hook bus coupling); call sites in
 * `server/handlers/cms/*` and the publish-scheduler call these helpers
 * immediately after a successful mutation.
 */

import type { ContentEntryActor } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'
import { getRowTableRouteInfo } from '../repositories/data/publish'

/** Look up the table slug for a row id — needed to populate the event payload. */
async function resolveTableSlug(rowId: string): Promise<string | null> {
  const info = await getRowTableRouteInfo(rowId)
  return info?.tableSlug ?? null
}

export async function emitContentEntryCreated(
  rowId: string,
  actor: ContentEntryActor,
): Promise<void> {
  const tableSlug = await resolveTableSlug(rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.created', { tableSlug, entryId: rowId, actor })
}

export async function emitContentEntryUpdated(
  rowId: string,
  changedFieldIds: string[],
  actor: ContentEntryActor,
): Promise<void> {
  const tableSlug = await resolveTableSlug(rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.updated', {
    tableSlug,
    entryId: rowId,
    changedFieldIds,
    actor,
  })
}

export async function emitContentEntryDeleted(
  rowId: string,
  actor: ContentEntryActor,
): Promise<void> {
  const tableSlug = await resolveTableSlug(rowId)
  if (!tableSlug) return
  await hookBus.emit('content.entry.deleted', { tableSlug, entryId: rowId, actor })
}

/**
 * Run the `content.entry.cells` filter pipeline. Plugin handlers (the
 * `cms.content.*` surface) call this directly; admin CMS handlers can
 * call it too if they want plugin-driven normalization.
 */
export async function applyContentEntryCellsFilter(
  cells: Record<string, unknown>,
  ctx: {
    tableSlug: string
    entryId: string
    actor: ContentEntryActor
  },
): Promise<Record<string, unknown>> {
  return hookBus.applyFilter('content.entry.cells', cells, {
    tableSlug: ctx.tableSlug,
    entryId: ctx.entryId,
    actor: ctx.actor,
  })
}
