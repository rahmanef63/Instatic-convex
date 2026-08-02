/**
 * Publish lineup widget reader — three slices joined by status:
 * upcoming scheduled, recently published, drafts in progress.
 */
import { isoDateOrNull } from '@core/utils/isoDate'
import type { DataRow } from '@core/data/schemas'
import { listDataRows, listDataTables } from '../../../repositories/data'
import { buildRowPath } from './shared'
import type { PublishLineupRow, PublishLineupStats } from './types'

const SCHEDULED_LIMIT = 3
const PUBLISHED_LIMIT = 2
const DRAFT_LIMIT = 2

type LineupRow = {
  id: string
  slug: string
  table_id: string
  route_base: string | null
  status: DataRow['status']
  scheduled_publish_at: string | null
  published_at: string | null
  updated_at: string
}

/**
 * Pull the rows that fill the dashboard "Publish lineup" widget.
 *
 *   • Up to 3 upcoming scheduled rows, soonest-first
 *   • Up to 2 recently-published rows, newest-first
 *   • Up to 2 drafts, most-recently-touched first
 *
 * Joined to `data_tables` so we can render the row's public path
 * (`route_base + slug`) — matches what the user sees in the editor.
 * Three separate queries (not one UNION) because:
 *   1. ANSI SQL UNION with mixed ORDER BY is dialect-painful, and
 *   2. The three slices have different sort keys, which a UNION would
 *      force into a single composite key.
 *
 * Combined and ordered client-side: scheduled rows (chronological,
 * soonest first) → published rows (newest first) → drafts. Same order
 * the original mocked widget used so the visual rhythm is preserved.
 */
export async function readPublishLineup(): Promise<PublishLineupStats> {
  // The repository reads are per-table, so collect every table's rows once
  // and slice the three status lanes client-side. The dashboard widget is a
  // small snapshot — full-table reads are acceptable here.
  const tables = await listDataTables()
  const routeBaseByTable = new Map(tables.map((t) => [t.id, t.routeBase]))
  const perTable = await Promise.all(tables.map((t) => listDataRows(t.id)))
  const allRows: LineupRow[] = perTable.flat().map((r) => toLineupRow(r, routeBaseByTable))

  const scheduled = allRows
    .filter((r) => r.status === 'scheduled' && r.scheduled_publish_at !== null)
    .sort((a, b) => (a.scheduled_publish_at! < b.scheduled_publish_at! ? -1 : 1))
    .slice(0, SCHEDULED_LIMIT)
  const published = allRows
    .filter((r) => r.status === 'published' && r.published_at !== null)
    .sort((a, b) => (a.published_at! > b.published_at! ? -1 : 1))
    .slice(0, PUBLISHED_LIMIT)
  const drafts = allRows
    .filter((r) => r.status === 'draft')
    .sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1))
    .slice(0, DRAFT_LIMIT)

  const rows: PublishLineupRow[] = [
    ...scheduled.map((r): PublishLineupRow => ({
      id: r.id,
      path: buildRowPath(r.route_base, r.table_id, r.slug),
      status: 'scheduled',
      at: isoDateOrNull(r.scheduled_publish_at),
    })),
    ...published.map((r): PublishLineupRow => ({
      id: r.id,
      path: buildRowPath(r.route_base, r.table_id, r.slug),
      status: 'published',
      at: isoDateOrNull(r.published_at),
    })),
    ...drafts.map((r): PublishLineupRow => ({
      id: r.id,
      path: buildRowPath(r.route_base, r.table_id, r.slug),
      status: 'draft',
      at: null,
    })),
  ]

  return { rows }
}

function toLineupRow(row: DataRow, routeBaseByTable: Map<string, string>): LineupRow {
  return {
    id: row.id,
    slug: row.slug,
    table_id: row.tableId,
    route_base: routeBaseByTable.get(row.tableId) ?? null,
    status: row.status,
    scheduled_publish_at: row.scheduledPublishAt,
    published_at: row.publishedAt,
    updated_at: row.updatedAt,
  }
}
