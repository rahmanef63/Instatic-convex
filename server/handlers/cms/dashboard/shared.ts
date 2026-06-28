/**
 * Shared helpers used by multiple dashboard widget readers.
 *
 * Anything in this module is consumed by 2+ readers. One-reader helpers
 * stay co-located in their reader's file so the call site is obvious and
 * the surface here doesn't bloat into a junk drawer.
 *
 *   • `readStatusCounts`        — Pages, Posts
 *   • `readPublishedSinceCount` — Pages (Posts uses the histogram instead)
 *   • `buildRowPath`            — Publish lineup, Activity
 */
import { listDataRows } from '../../../repositories/data'

/**
 * Group counts of `data_rows.status` for a single table. Returns
 * {draft, published, scheduled, total}. `total` is the sum of those three
 * editorial statuses only — `unpublished` rows are intentionally excluded,
 * matching the widget's "live editorial backlog" framing.
 */
export async function readStatusCounts(
  tableId: string,
): Promise<{ total: number; published: number; drafts: number; scheduled: number }> {
  const rows = await listDataRows(tableId)
  let published = 0
  let drafts = 0
  let scheduled = 0
  for (const r of rows) {
    if (r.status === 'published') published += 1
    else if (r.status === 'draft') drafts += 1
    else if (r.status === 'scheduled') scheduled += 1
  }
  return {
    total: published + drafts + scheduled,
    published,
    drafts,
    scheduled,
  }
}

/**
 * Count `data_rows` whose `publishedAt` lies in the trailing window,
 * for one table. Used by the Pages widget's "+N this week" delta.
 */
export async function readPublishedSinceCount(
  tableId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await listDataRows(tableId)
  return rows.filter(
    (r) => r.status === 'published' && r.publishedAt !== null && r.publishedAt >= sinceIso,
  ).length
}

/**
 * Build the public path for a content row from its table's route_base
 * and the row's slug. Shared by the Publish lineup and Activity widgets
 * so both render the same `/blog/<slug>` style label.
 *
 *   • Falls back to `/${tableId}/<slug>` when route_base is missing
 *     (collection still being set up, or a system table without a
 *     route prefix yet).
 *   • An empty slug renders as the literal `(no slug)` placeholder so
 *     the row stays clickable in the widget instead of dropping a
 *     trailing slash that looks like a broken link.
 */
export function buildRowPath(routeBase: string | null, tableId: string, slug: string): string {
  const safeSlug = slug || '(no slug)'
  const base = routeBase && routeBase.trim().length > 0 ? routeBase : `/${tableId}`
  const normalizedBase = base.startsWith('/') ? base : `/${base}`
  const trimmedBase = normalizedBase.endsWith('/') ? normalizedBase.slice(0, -1) : normalizedBase
  return `${trimmedBase}/${safeSlug}`
}
