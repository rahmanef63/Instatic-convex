/**
 * Posts widget reader — aggregate totals across every `kind: 'postType'`
 * table plus a dense 28-day publish histogram for the widget's mini bar
 * chart.
 */
import { localDayKeyFactory } from '../../../time'
import { listDataRows, listDataTables } from '../../../repositories/data'
import { readStatusCounts } from './shared'
import type { DashboardRequestContext, PostsStats } from './types'

const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const HISTOGRAM_DAYS = 28

export async function readPostsStats(
  _options: unknown,
  ctx: DashboardRequestContext,
): Promise<PostsStats> {
  const dayKeyOf = localDayKeyFactory(ctx.timeZone)
  const sinceIso = new Date(Date.now() - TWENTY_EIGHT_DAYS_MS).toISOString()
  const tables = await listDataTables()
  const postTypeIds = tables.filter((t) => t.kind === 'postType').map((t) => t.id)

  // Read per-table counts + the histogram in parallel — they are
  // independent reads against the same rows.
  const [countsArr, histogram] = await Promise.all([
    Promise.all(postTypeIds.map((id) => readStatusCounts(id))),
    readPostsHistogram(postTypeIds, sinceIso, dayKeyOf),
  ])

  let postsTotal = 0
  let postsScheduled = 0
  for (const c of countsArr) {
    postsTotal += c.total
    postsScheduled += c.scheduled
  }

  // Densify into [28] oldest-first. The bucket labels are the viewer's local
  // calendar days, matching how the histogram binned each published_at — so
  // "today" lines up with the operator's day, not UTC's.
  const daily28 = Array.from({ length: HISTOGRAM_DAYS }, (_, i) => {
    const d = new Date(Date.now() - (HISTOGRAM_DAYS - 1 - i) * DAY_MS)
    return histogram.get(dayKeyOf(d)) ?? 0
  })

  return {
    total: postsTotal,
    categories: postTypeIds.length,
    scheduled: postsScheduled,
    daily28,
  }
}

/**
 * 28-day publish histogram across ALL post-type tables. Groups by the
 * viewer's local calendar day (via `dayKeyOf`, an IANA-zone mapper) so the
 * bars align with the operator's days rather than UTC. The caller
 * post-processes the rows into a dense [28]-array so the front-end can
 * render bars without conditional gaps.
 *
 * We pull every post-type table's rows and bin them client-side because the
 * day boundary depends on the viewer's timezone — which the data store can't
 * know. Cardinality is bounded by the post-type table count times each
 * table's row count — comfortably small for a dashboard snapshot.
 */
async function readPostsHistogram(
  postTypeTableIds: readonly string[],
  sinceIso: string,
  dayKeyOf: (value: string | Date) => string,
): Promise<Map<string, number>> {
  if (postTypeTableIds.length === 0) return new Map()
  const perTable = await Promise.all(postTypeTableIds.map((id) => listDataRows(id)))
  const counts = new Map<string, number>()
  for (const rows of perTable) {
    for (const r of rows) {
      if (r.status !== 'published' || r.publishedAt === null || r.publishedAt < sinceIso) continue
      const day = dayKeyOf(r.publishedAt)
      counts.set(day, (counts.get(day) ?? 0) + 1)
    }
  }
  return counts
}
