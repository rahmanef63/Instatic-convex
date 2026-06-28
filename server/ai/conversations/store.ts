/**
 * Conversations + messages repository — CRUD over `ai_conversations` and
 * `ai_messages`.
 *
 * Per-user, per-scope. Every query carries `user_id` as a cross-user guard
 * (defence in depth on top of handler-level capability gating).
 *
 * Soft-delete via `deleted_at`; the nightly purge job (`boot.ts`)
 * hard-deletes rows older than 30 days.
 *
 * Convex port: the read/write bodies are thin adapters over
 * `convex/aiConversations.ts` (docs/CONVEX-MIGRATION.md §2). The row→record
 * mappers + `AiContentBlockSchema` validation stay here so the `@core` TypeBox
 * canon never runs in Convex's V8 runtime.
 *
 * @see convex/aiConversations.ts — the Convex query/mutation functions
 */

import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { AiContentBlockSchema } from '@core/ai'
import { api, getConvex } from '../../convex/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import type { AiContentBlock, ToolScope } from '../runtime/types'
import type {
  AppendMessageInput,
  ConversationDetailView,
  ConversationRecord,
  ConversationView,
  CreateConversationInput,
  MessageRecord,
  MessageRole,
  MessageView,
  UpdateConversationInput,
} from './types'

// ---------------------------------------------------------------------------
// Row shapes ↔ records
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string
  user_id: string
  scope: string
  title: string
  credential_id: string | null
  model_id: string
  prompt_tokens_total: number | string
  completion_tokens_total: number | string
  cost_usd_total: number | string
  cache_read_tokens_total: number | string
  cache_creation_tokens_total: number | string
  context_tokens: number | string
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
}

interface MessageRow {
  id: string
  conversation_id: string
  position: number
  role: string
  // Both dialects auto-hydrate `_json` columns to JS values (SQLite via the
  // adapter's parseJsonColumns; PG via jsonb). The row arrives already-parsed.
  content_json: unknown
  tool_call_id: string | null
  tool_name: string | null
  prompt_tokens: number
  completion_tokens: number
  cost_usd: number | string
  cache_read_tokens: number
  cache_creation_tokens: number
  created_at: Date | string
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value)
}

function conversationRowToRecord(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as ToolScope,
    title: row.title,
    credentialId: row.credential_id,
    modelId: row.model_id,
    promptTokensTotal: toNumber(row.prompt_tokens_total),
    completionTokensTotal: toNumber(row.completion_tokens_total),
    costUsdTotal: toNumber(row.cost_usd_total),
    cacheReadTokensTotal: toNumber(row.cache_read_tokens_total),
    cacheCreationTokensTotal: toNumber(row.cache_creation_tokens_total),
    contextTokens: toNumber(row.context_tokens),
    createdAt: isoDateOrNull(row.created_at)!,
    updatedAt: isoDateOrNull(row.updated_at)!,
    deletedAt: isoDateOrNull(row.deleted_at),
  }
}

const ContentBlocksSchema = Type.Array(AiContentBlockSchema)

function parseContentBlocks(raw: unknown): AiContentBlock[] {
  // SQLite adapter + PG jsonb both deliver this column pre-parsed. This is the
  // read boundary: every block is validated against the canonical
  // `AiContentBlockSchema`, so callers (e.g. `buildMessageHistory`) receive a
  // fully-typed `AiContentBlock[]` and never re-cast.
  const parsed = safeParseValue(ContentBlocksSchema, raw)
  if (!parsed.ok) {
    // Defensive: don't crash an entire history fetch over one bad row.
    console.error('[ai/conversations] Malformed content_json row, returning empty blocks.')
    return []
  }
  return parsed.value
}

function messageRowToRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    position: row.position,
    role: row.role as MessageRole,
    content: parseContentBlocks(row.content_json),
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    costUsd: toNumber(row.cost_usd),
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    createdAt: isoDateOrNull(row.created_at)!,
  }
}

// ---------------------------------------------------------------------------
// Wire projections
// ---------------------------------------------------------------------------

export function toConversationView(record: ConversationRecord): ConversationView {
  return {
    id: record.id,
    scope: record.scope,
    title: record.title,
    credentialId: record.credentialId,
    modelId: record.modelId,
    promptTokensTotal: record.promptTokensTotal,
    completionTokensTotal: record.completionTokensTotal,
    costUsdTotal: record.costUsdTotal,
    cacheReadTokensTotal: record.cacheReadTokensTotal,
    cacheCreationTokensTotal: record.cacheCreationTokensTotal,
    contextTokens: record.contextTokens,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function toMessageView(record: MessageRecord): MessageView {
  return {
    id: record.id,
    position: record.position,
    role: record.role,
    content: record.content,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    createdAt: record.createdAt,
  }
}

export function toConversationDetailView(
  conversation: ConversationRecord,
  messages: MessageRecord[],
): ConversationDetailView {
  return {
    ...toConversationView(conversation),
    messages: messages.map(toMessageView),
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List non-deleted conversations for one user + scope, newest activity
 * first. Served by the `by_user_scope_updated` index.
 */
export async function listConversationsForUserScope(
  userId: string,
  scope: ToolScope,
): Promise<ConversationRecord[]> {
  const rows = await getConvex().query(api.aiConversations.listForUserScope, {
    userId,
    scope,
  })
  return rows.map(conversationRowToRecord)
}

/**
 * Read a single conversation with cross-user guard. Returns null for not
 * found / not yours / soft-deleted.
 */
export async function readConversationForUser(
  userId: string,
  conversationId: string,
): Promise<ConversationRecord | null> {
  const row = await getConvex().query(api.aiConversations.readForUser, {
    userId,
    conversationId,
  })
  return row ? conversationRowToRecord(row) : null
}

/**
 * Read every message of a conversation in position order. Caller must have
 * already verified ownership via `readConversationForUser`.
 */
export async function listMessagesForConversation(
  conversationId: string,
): Promise<MessageRecord[]> {
  const rows = await getConvex().query(api.aiConversations.listMessages, {
    conversationId,
  })
  return rows.map(messageRowToRecord)
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create a new conversation row. `title` defaults to "New conversation" —
 * the runner can rename it after the first user message lands (or the UI
 * can offer "Rename this chat").
 */
export async function createConversationForUser(
  userId: string,
  input: CreateConversationInput,
): Promise<ConversationRecord> {
  const title = (input.title ?? '').trim() || 'New conversation'
  const row = await getConvex().mutation(api.aiConversations.create, {
    userId,
    scope: input.scope,
    title,
    credentialId: input.credentialId,
    modelId: input.modelId,
  })
  return conversationRowToRecord(row)
}

/**
 * Patch a conversation. Pass only fields to update.
 */
export async function updateConversationForUser(
  userId: string,
  conversationId: string,
  patch: UpdateConversationInput,
): Promise<ConversationRecord | null> {
  const existing = await readConversationForUser(userId, conversationId)
  if (!existing) return null

  const nextTitle = patch.title?.trim() || existing.title
  const nextCredentialId =
    patch.credentialId !== undefined ? patch.credentialId : existing.credentialId
  const nextModelId =
    patch.modelId !== undefined ? patch.modelId : existing.modelId

  const row = await getConvex().mutation(api.aiConversations.update, {
    userId,
    conversationId,
    title: nextTitle,
    credentialId: nextCredentialId,
    modelId: nextModelId,
  })
  return row ? conversationRowToRecord(row) : null
}

/**
 * Soft-delete by setting `deleted_at`. Idempotent — calling on an
 * already-deleted row sets deleted_at to the current time again.
 * Returns true when a row was matched.
 */
export async function softDeleteConversationForUser(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  return getConvex().mutation(api.aiConversations.softDelete, {
    userId,
    conversationId,
  })
}

/**
 * Append a message to an existing conversation. The next `position` and the
 * parent conversation's denormalised token/cost totals are computed inside the
 * atomic Convex mutation (§3 #14) — single-writer per conversation, so no race.
 */
export async function appendMessage(
  conversationId: string,
  input: AppendMessageInput,
): Promise<MessageRecord> {
  const row = await getConvex().mutation(api.aiConversations.appendMessage, {
    conversationId,
    role: input.role,
    content: input.content,
    toolCallId: input.toolCallId ?? null,
    toolName: input.toolName ?? null,
    promptTokens: input.promptTokens ?? 0,
    completionTokens: input.completionTokens ?? 0,
    costUsd: input.costUsd ?? 0,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheCreationTokens: input.cacheCreationTokens ?? 0,
  })
  return messageRowToRecord(row)
}

// ---------------------------------------------------------------------------
// Purge — used by the nightly tick job (boot.ts).
// ---------------------------------------------------------------------------

/**
 * Hard-delete soft-deleted conversations older than `cutoffIsoString`, plus
 * their messages (Convex has no cascade — `purgeSoftDeleted` deletes them
 * explicitly, §3 #15). Returns the number of CONVERSATIONS purged.
 */
export async function purgeSoftDeletedOlderThan(
  cutoffIsoString: string,
): Promise<number> {
  return getConvex().mutation(api.aiConversations.purgeSoftDeleted, {
    cutoffIso: cutoffIsoString,
  })
}
