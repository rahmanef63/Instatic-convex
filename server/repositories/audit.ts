import { Type, type Static } from '@core/utils/typeboxHelpers'
import { compiledCheck, compiledDecode } from '@core/utils/typeboxCompiler'
import { api, getConvex } from '../convex/client'

const AuditActionSchema = Type.Union([
  Type.Literal('login.success'),
  Type.Literal('login.failure'),
  Type.Literal('login.locked'),
  Type.Literal('login.unlocked'),
  Type.Literal('login.rate_limited'),
  Type.Literal('logout'),
  Type.Literal('user.create'),
  Type.Literal('user.update'),
  Type.Literal('user.delete'),
  Type.Literal('user.suspend'),
  Type.Literal('password.change'),
  Type.Literal('role.create'),
  Type.Literal('role.update'),
  Type.Literal('role.delete'),
  Type.Literal('role.assign'),
  Type.Literal('data.table.create'),
  Type.Literal('data.table.update'),
  Type.Literal('data.table.delete'),
  Type.Literal('data.row.create'),
  Type.Literal('data.row.update'),
  Type.Literal('data.row.delete'),
  Type.Literal('data.row.publish'),
  Type.Literal('data.row.schedule'),
  Type.Literal('data.row.schedule.cancel'),
  Type.Literal('data.row.status'),
  Type.Literal('data.row.move'),
  Type.Literal('data.author.assign'),
  Type.Literal('publish'),
  Type.Literal('plugin.install'),
  Type.Literal('plugin.update'),
  Type.Literal('plugin.enable'),
  Type.Literal('plugin.disable'),
  Type.Literal('plugin.delete'),
  Type.Literal('plugin.pack.install'),
  Type.Literal('plugin.settings.update'),
  // AI runtime — see `docs/plans/2026-05-26-ai-runtime-rewrite.md` § Audit.
  Type.Literal('ai.credential.created'),
  Type.Literal('ai.credential.updated'),
  Type.Literal('ai.credential.deleted'),
  Type.Literal('ai.credential.tested'),
  Type.Literal('ai.default.updated'),
  Type.Literal('ai.default.cleared'),
  Type.Literal('ai.chat.started'),
  Type.Literal('ai.chat.completed'),
  Type.Literal('ai.chat.failed'),
])

const AuditMetadataSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Array(Type.String())]),
)

export type AuditAction = Static<typeof AuditActionSchema>
type AuditMetadata = Static<typeof AuditMetadataSchema>

interface AuditEventRow {
  id: string
  actor_user_id: string | null
  action: AuditAction
  target_type: string | null
  target_id: string | null
  metadata_json: unknown
  ip_address: string | null
  user_agent: string | null
  created_at: Date | string
}

interface AuditUserLabelRow {
  id: string
  email: string
  display_name: string
}

interface AuditEventLabels {
  actorLabel: string | null
  targetLabel: string | null
  metadataLabels: Record<string, string>
}

interface AuditEvent {
  id: string
  actorUserId: string | null
  action: AuditAction
  targetType: string | null
  targetId: string | null
  metadata: AuditMetadata
  actorLabel: string | null
  targetLabel: string | null
  metadataLabels: Record<string, string>
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

function normalizeMetadata(value: unknown): AuditMetadata {
  return compiledCheck(AuditMetadataSchema, value) ? compiledDecode(AuditMetadataSchema, value) : {}
}

function userAuditLabel(row: AuditUserLabelRow): string {
  return row.display_name.trim() || row.email || row.id
}

function metadataString(metadata: AuditMetadata, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function rowToAuditEvent(row: AuditEventRow, metadata: AuditMetadata, labels: AuditEventLabels): AuditEvent {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata,
    actorLabel: labels.actorLabel,
    targetLabel: labels.targetLabel,
    metadataLabels: labels.metadataLabels,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

function labelsForAuditEvent(
  row: AuditEventRow,
  metadata: AuditMetadata,
  maps: { usersById: Map<string, string>; rolesById: Map<string, string> },
): AuditEventLabels {
  const metadataLabels: Record<string, string> = {}
  const roleId = metadataString(metadata, 'roleId')
  if (roleId) {
    const roleLabel = maps.rolesById.get(roleId)
    if (roleLabel) metadataLabels.roleId = roleLabel
  }

  const actorLabel = row.actor_user_id ? maps.usersById.get(row.actor_user_id) ?? null : null
  const targetLabel = row.target_type === 'user' && row.target_id
    ? maps.usersById.get(row.target_id) ?? null
    : row.target_type === 'role' && row.target_id
      ? maps.rolesById.get(row.target_id) ?? metadataString(metadata, 'name') ?? metadataString(metadata, 'slug')
      : null

  return { actorLabel, targetLabel, metadataLabels }
}

export async function createAuditEvent(
  input: {
    actorUserId: string | null
    action: AuditAction
    targetType?: string | null
    targetId?: string | null
    metadata?: AuditMetadata
    ipAddress?: string | null
    userAgent?: string | null
  },
): Promise<void> {
  await getConvex().mutation(api.audit.create, {
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? {},
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  })
}

export async function listAuditEvents(limit = 100): Promise<AuditEvent[]> {
  const { events, users, roles } = await getConvex().query(api.audit.listEvents, { limit })

  const usersById = new Map<string, string>()
  for (const user of users) usersById.set(user.id, userAuditLabel(user))
  const rolesById = new Map<string, string>()
  for (const role of roles) rolesById.set(role.id, role.name)
  const maps = { usersById, rolesById }

  return events.map((event) => {
    // `action` is a constrained enum column; the Convex validator widens it to
    // `string`, so narrow it back to `AuditAction`.
    const row: AuditEventRow = { ...event, action: event.action as AuditAction }
    const metadata = normalizeMetadata(row.metadata_json)
    return rowToAuditEvent(row, metadata, labelsForAuditEvent(row, metadata, maps))
  })
}
