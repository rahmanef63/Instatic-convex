/**
 * Recent Activity widget reader — a curated slice of `audit_events`,
 * joined to current `users` / `data_tables` and projected into a
 * widget-ready shape so the front-end can render each row without
 * extra lookups.
 *
 *   • `login.*` and `logout` events live in Account → Sign-in history.
 *     The dashboard Activity widget is about *operational* changes to
 *     the site, so we skip them — they would otherwise drown out the
 *     signal on a busy login day.
 *   • For each `data.row.*` event we resolve `tableId + slug →
 *     /route_base/slug` so the row reads "edited /blog/launching-…".
 *     Route-base lookups are batched against `data_tables` to avoid an
 *     N+1 over the visible window.
 */
import type { AuditAction } from '../../../repositories/audit'
import { isoDateOrNull } from '@core/utils/isoDate'
import { listAuditEvents } from '../../../repositories/audit'
import { listUsers } from '../../../repositories/users'
import { listDataTables } from '../../../repositories/data'
import { buildRowPath } from './shared'
import type { RecentActivityActor, RecentActivityEntry, RecentActivityStats } from './types'

const WIDGET_LIMIT = 10
// Oversized window so we can drop login.* noise (filtered in JS; see
// `isDashboardActivityNoise`) and still have enough rows to fill the
// widget. 50 is the practical ceiling: even a busy admin afternoon
// rarely produces more than that, and the audit feed is returned
// newest-first so this is a cheap read.
const FETCH_LIMIT = 50

type ActivityRow = {
  id: string
  actor_user_id: string | null
  action: AuditAction
  target_type: string | null
  target_id: string | null
  metadata_json: unknown
  created_at: string | Date
  actor_display_name: string | null
  actor_email: string | null
  actor_avatar_path: string | null
  actor_gravatar_hash: string | null
  target_user_display_name: string | null
  target_user_email: string | null
}

export async function readRecentActivity(): Promise<RecentActivityStats> {
  // The actor / target-user enrichment that the old SQL did via joins is now
  // assembled in-process: the audit feed gives the events, `listUsers()`
  // supplies the current display name / email / avatar / gravatar for each
  // user id (uploaded image first, Gravatar fallback, then initials), and the
  // table list resolves data-row route bases.
  const [events, users] = await Promise.all([listAuditEvents(FETCH_LIMIT), listUsers()])
  const usersById = new Map(users.map((u) => [u.id, u]))

  const rows: ActivityRow[] = events.map((e) => {
    const actor = e.actorUserId ? usersById.get(e.actorUserId) : undefined
    const targetUser = e.targetType === 'user' && e.targetId ? usersById.get(e.targetId) : undefined
    return {
      id: e.id,
      actor_user_id: e.actorUserId,
      action: e.action,
      target_type: e.targetType,
      target_id: e.targetId,
      metadata_json: e.metadata,
      created_at: e.createdAt,
      actor_display_name: actor?.displayName ?? null,
      actor_email: actor?.email ?? null,
      actor_avatar_path: actor?.avatarUrl ?? null,
      actor_gravatar_hash: actor?.gravatarHash ?? null,
      target_user_display_name: targetUser?.displayName ?? null,
      target_user_email: targetUser?.email ?? null,
    }
  })

  const visible = rows.filter((r) => !isDashboardActivityNoise(r.action)).slice(0, WIDGET_LIMIT)
  const routeBaseById = await loadRouteBases(visible)

  return {
    rows: visible.map((r): RecentActivityEntry => projectActivityRow(r, routeBaseById)),
  }
}

/**
 * `login.*` and `logout` events live in Account → Sign-in history. The
 * dashboard Activity widget is about *operational* changes to the site,
 * so we skip them — they would otherwise drown out the signal on a
 * busy login day.
 */
function isDashboardActivityNoise(action: AuditAction): boolean {
  return action.startsWith('login.') || action === 'logout'
}

/**
 * Look up the route_base for every data.* event in one pass so we can
 * build "/blog/launching-…" paths without an N+1. Returns a map keyed
 * by table id; missing entries fall through to {@link buildRowPath}'s
 * `/${tableId}/` fallback.
 */
async function loadRouteBases(
  visible: readonly ActivityRow[],
): Promise<Map<string, string | null>> {
  const tableIds = new Set<string>()
  for (const r of visible) {
    if (r.action.startsWith('data.row.') || r.action === 'data.author.assign') {
      const meta = metadataAsRecord(r.metadata_json)
      const tableId = readMetadataString(meta, 'tableId')
      if (tableId) tableIds.add(tableId)
    }
  }
  const routeBaseById = new Map<string, string | null>()
  if (tableIds.size === 0) return routeBaseById
  const tables = await listDataTables()
  for (const table of tables) {
    if (tableIds.has(table.id)) routeBaseById.set(table.id, table.routeBase)
  }
  return routeBaseById
}

function projectActivityRow(
  row: ActivityRow,
  routeBaseById: Map<string, string | null>,
): RecentActivityEntry {
  const metadata = metadataAsRecord(row.metadata_json)
  const target = resolveActivityTarget(row.action, row.target_id, metadata, routeBaseById, {
    targetUserLabel: userDisplayLabel(row.target_user_display_name, row.target_user_email),
  })

  return {
    id: row.id,
    action: row.action,
    actor: buildActor(row),
    targetCode: target.code,
    targetText: target.text,
    createdAt: isoDateOrNull(row.created_at) ?? '',
  }
}

/**
 * Build the actor payload for an audit row. Returns null for
 * system-initiated events (no actor user). When the actor user has
 * since been deleted the join columns come back null too; we surface
 * that as a system row rather than ghosting the row with placeholder
 * text — the widget already has a clean fallback.
 */
function buildActor(row: ActivityRow): RecentActivityActor | null {
  if (row.actor_user_id === null || row.actor_email === null) return null
  return {
    displayName: row.actor_display_name ?? '',
    email: row.actor_email,
    avatarUrl: row.actor_avatar_path,
    gravatarHash: row.actor_gravatar_hash ?? '',
  }
}

function metadataAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | null {
  const v = metadata[key]
  return typeof v === 'string' && v.trim() ? v : null
}

function userDisplayLabel(displayName: string | null, email: string | null): string | null {
  const cleanName = displayName?.trim() ?? ''
  if (cleanName) return cleanName
  if (email && email.trim()) return email
  return null
}

/**
 * Resolve the `targetCode` / `targetText` pair for a single activity
 * row. The split between the two fields is the widget's contract:
 * `targetCode` renders in <code> styling (paths, slugs, plugin ids);
 * `targetText` renders in plain styling (human names). Each action
 * picks one or the other — never both.
 */
function resolveActivityTarget(
  action: AuditAction,
  targetId: string | null,
  metadata: Record<string, unknown>,
  routeBaseById: Map<string, string | null>,
  context: { targetUserLabel: string | null },
): { code: string | null; text: string | null } {
  // Data-row events: render a code-styled path so the row reads
  // "edited /blog/launching-instatic".
  if (action.startsWith('data.row.') || action === 'data.author.assign') {
    const tableId = readMetadataString(metadata, 'tableId')
    const slug = readMetadataString(metadata, 'slug')
    if (tableId && slug !== null) {
      return { code: buildRowPath(routeBaseById.get(tableId) ?? null, tableId, slug ?? ''), text: null }
    }
    return { code: null, text: null }
  }

  // Data-table events: target_id is the collection id, metadata.name
  // is the human label. Prefer the human label when present.
  if (action.startsWith('data.table.')) {
    const name = readMetadataString(metadata, 'name')
    if (name) return { code: null, text: name }
    return { code: targetId ?? null, text: null }
  }

  // Plugin events: pluginId may live in metadata (preferred) or
  // target_id depending on the call site.
  if (action.startsWith('plugin.')) {
    const pluginId = readMetadataString(metadata, 'pluginId') ?? targetId
    return { code: pluginId, text: null }
  }

  // User events: prefer the current display name (joined), fall back
  // to the snapshot stored in metadata.email so a deleted user still
  // renders something useful.
  if (action.startsWith('user.') || action === 'password.change') {
    if (context.targetUserLabel) return { code: null, text: context.targetUserLabel }
    const email = readMetadataString(metadata, 'email')
    if (email) return { code: null, text: email }
    return { code: null, text: targetId ?? null }
  }

  // Role events: target_id is the role id. metadata.name carries
  // the snapshot label; for role.assign the actual subject is the
  // user being assigned to (handled separately by the widget verb).
  if (action.startsWith('role.')) {
    const name = readMetadataString(metadata, 'name')
    if (name) return { code: null, text: name }
    return { code: null, text: targetId ?? null }
  }

  // 'publish' — no per-row target; the verb alone reads "published the site".
  return { code: null, text: null }
}
