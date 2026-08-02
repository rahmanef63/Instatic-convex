/**
 * AI conversations + messages — Convex functions.
 *
 * The Convex half of the `ai_conversations` / `ai_messages` domain; the thin
 * repository adapters (`server/ai/conversations/store.ts` +
 * `server/ai/runtime/persister.ts`) marshal args into these and map the results
 * back into the frozen `ConversationRecord` / `MessageRecord` shapes
 * (docs/CONVEX-MIGRATION.md §2). The split mirrors the proven `users` /
 * `dataRows` slices:
 *
 * - **Mapping stays in the repository.** Each read here returns a *row* shaped
 *   exactly like the repository's `ConversationRow` / `MessageRow`; the
 *   repository's `conversationRowToRecord` / `messageRowToRecord` (with the
 *   `AiContentBlockSchema` validation in `parseContentBlocks`) turn those rows
 *   into records. This keeps the `@core` TypeBox validation out of the Convex V8
 *   runtime.
 * - **`content_json` is an opaque JSON string at rest** (§6); it is `JSON.parse`d
 *   here into the block array the repository's `parseContentBlocks` validates,
 *   and `JSON.stringify`d on write (the old SQLite/PG `_json` auto-(de)serialise).
 *
 * Transactions collapsed to single atomic mutations (docs/CONVEX-MIGRATION.md
 * §3): `appendMessage` (#14 — compute next position + insert message + bump the
 * parent's denormalised token/cost totals), `purgeSoftDeleted` (#15 — count +
 * delete soft-deleted conversations AND their messages explicitly, since Convex
 * has no cascade), `updateMessageTokens` (#16 — patch one message's tokens +
 * propagate the delta onto the parent conversation totals).
 *
 * App identity is the nanoid `id`, generated here when not supplied;
 * `created_at` / `updated_at` (SQL column defaults) are stamped here. Convex
 * `_id` never leaks out. Every function declares both `args` AND `returns`
 * validators.
 *
 * @see server/ai/conversations/store.ts — the thin repository adapter
 * @see server/ai/runtime/persister.ts   — the runner persistence sink
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

const scopeValidator = v.union(
  v.literal('site'),
  v.literal('content'),
  v.literal('data'),
  v.literal('plugin'),
)

const roleValidator = v.union(
  v.literal('user'),
  v.literal('assistant'),
  v.literal('tool'),
)

/** Shaped exactly like the repository's `ConversationRow`. */
const conversationRowValidator = v.object({
  id: v.string(),
  user_id: v.string(),
  scope: scopeValidator,
  title: v.string(),
  credential_id: v.union(v.null(), v.string()),
  model_id: v.string(),
  prompt_tokens_total: v.number(),
  completion_tokens_total: v.number(),
  cost_usd_total: v.number(),
  cache_read_tokens_total: v.number(),
  cache_creation_tokens_total: v.number(),
  context_tokens: v.number(),
  created_at: v.string(),
  updated_at: v.string(),
  deleted_at: v.union(v.null(), v.string()),
})

/**
 * Shaped exactly like the repository's `MessageRow`. `content_json` is the
 * already-parsed block array (the repository re-validates it against
 * `AiContentBlockSchema`); it is always an array of content blocks.
 */
const messageRowValidator = v.object({
  id: v.string(),
  conversation_id: v.string(),
  position: v.number(),
  role: roleValidator,
  content_json: v.array(v.any()),
  tool_call_id: v.union(v.null(), v.string()),
  tool_name: v.union(v.null(), v.string()),
  prompt_tokens: v.number(),
  completion_tokens: v.number(),
  cost_usd: v.number(),
  cache_read_tokens: v.number(),
  cache_creation_tokens: v.number(),
  created_at: v.string(),
})

function conversationByAppId(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db
    .query('ai_conversations')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

function toConversationRow(row: Doc<'ai_conversations'>) {
  return {
    id: row.id,
    user_id: row.user_id,
    scope: row.scope,
    title: row.title,
    credential_id: row.credential_id,
    model_id: row.model_id,
    prompt_tokens_total: row.prompt_tokens_total,
    completion_tokens_total: row.completion_tokens_total,
    cost_usd_total: row.cost_usd_total,
    cache_read_tokens_total: row.cache_read_tokens_total,
    cache_creation_tokens_total: row.cache_creation_tokens_total,
    context_tokens: row.context_tokens,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  }
}

function toMessageRow(row: Doc<'ai_messages'>) {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    position: row.position,
    role: row.role,
    content_json: JSON.parse(row.content_json) as unknown[],
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    cost_usd: row.cost_usd,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    created_at: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Non-deleted conversations for one user + scope, newest activity first (the
 * SQL `order by updated_at desc`). The cross-user guard is the `user_id` eq on
 * the `by_user_scope_updated` index.
 */
export const listForUserScope = query({
  args: { userId: v.string(), scope: scopeValidator },
  returns: v.array(conversationRowValidator),
  handler: async (ctx, { userId, scope }) => {
    const rows = await ctx.db
      .query('ai_conversations')
      .withIndex('by_user_scope_updated', (q) =>
        q.eq('user_id', userId).eq('scope', scope),
      )
      .collect()
    return rows
      .filter((r) => r.deleted_at === null)
      .sort((a, b) =>
        a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
      )
      .map(toConversationRow)
  },
})

/** Read a single non-deleted conversation with the `user_id` cross-user guard. */
export const readForUser = query({
  args: { userId: v.string(), conversationId: v.string() },
  returns: v.union(v.null(), conversationRowValidator),
  handler: async (ctx, { userId, conversationId }) => {
    const row = await conversationByAppId(ctx, conversationId)
    if (!row || row.user_id !== userId || row.deleted_at !== null) return null
    return toConversationRow(row)
  },
})

/** Every message of a conversation in position order. Ownership checked by the caller. */
export const listMessages = query({
  args: { conversationId: v.string() },
  returns: v.array(messageRowValidator),
  handler: async (ctx, { conversationId }) => {
    const rows = await ctx.db
      .query('ai_messages')
      .withIndex('by_conversation_position', (q) =>
        q.eq('conversation_id', conversationId),
      )
      .collect()
    return rows.map(toMessageRow)
  },
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Insert a new conversation row; totals start at 0. Returns the row. */
export const create = mutation({
  args: {
    id: v.optional(v.string()),
    userId: v.string(),
    scope: scopeValidator,
    title: v.string(),
    credentialId: v.union(v.null(), v.string()),
    modelId: v.string(),
  },
  returns: conversationRowValidator,
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('ai_conversations', {
      id: args.id ?? nanoid(),
      user_id: args.userId,
      scope: args.scope,
      title: args.title,
      credential_id: args.credentialId,
      model_id: args.modelId,
      prompt_tokens_total: 0,
      completion_tokens_total: 0,
      cost_usd_total: 0,
      cache_read_tokens_total: 0,
      cache_creation_tokens_total: 0,
      context_tokens: 0,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    const fresh = await ctx.db.get(docId)
    return toConversationRow(fresh!)
  },
})

/**
 * Patch a conversation (title / credential / model). The repository has already
 * merged the patch over the current row and verified ownership, so every field
 * is passed fully resolved. The `user_id` guard re-checks ownership; returns
 * `null` when the row vanished between the repository's read and this write.
 */
export const update = mutation({
  args: {
    userId: v.string(),
    conversationId: v.string(),
    title: v.string(),
    credentialId: v.union(v.null(), v.string()),
    modelId: v.string(),
  },
  returns: v.union(v.null(), conversationRowValidator),
  handler: async (ctx, args) => {
    const row = await conversationByAppId(ctx, args.conversationId)
    if (!row || row.user_id !== args.userId) return null
    await ctx.db.patch(row._id, {
      title: args.title,
      credential_id: args.credentialId,
      model_id: args.modelId,
      updated_at: new Date().toISOString(),
    })
    const fresh = await ctx.db.get(row._id)
    return toConversationRow(fresh!)
  },
})

/**
 * Soft-delete by stamping `deleted_at`. Idempotent — re-deleting an
 * already-deleted row re-stamps it (the SQL carried no `deleted_at` guard).
 * Returns `true` when a row owned by `userId` was matched.
 */
export const softDelete = mutation({
  args: { userId: v.string(), conversationId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId, conversationId }) => {
    const row = await conversationByAppId(ctx, conversationId)
    if (!row || row.user_id !== userId) return false
    const now = new Date().toISOString()
    await ctx.db.patch(row._id, { deleted_at: now, updated_at: now })
    return true
  },
})

/**
 * Append a message to a conversation in ONE atomic mutation (§3 #14):
 *   1. compute the next `position` (max existing + 1, by index),
 *   2. insert the message (totals on the message start at the supplied values),
 *   3. bump the parent conversation's denormalised token/cost totals +
 *      `updated_at`, so list queries pick up the activity without aggregating.
 * Returns the inserted message row.
 */
export const appendMessage = mutation({
  args: {
    conversationId: v.string(),
    role: roleValidator,
    content: v.array(v.any()),
    toolCallId: v.union(v.null(), v.string()),
    toolName: v.union(v.null(), v.string()),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsd: v.number(),
    cacheReadTokens: v.number(),
    cacheCreationTokens: v.number(),
  },
  returns: messageRowValidator,
  handler: async (ctx, args) => {
    const last = await ctx.db
      .query('ai_messages')
      .withIndex('by_conversation_position', (q) =>
        q.eq('conversation_id', args.conversationId),
      )
      .order('desc')
      .first()
    const position = (last?.position ?? -1) + 1

    const now = new Date().toISOString()
    const docId = await ctx.db.insert('ai_messages', {
      id: nanoid(),
      conversation_id: args.conversationId,
      position,
      role: args.role,
      content_json: JSON.stringify(args.content),
      tool_call_id: args.toolCallId,
      tool_name: args.toolName,
      prompt_tokens: args.promptTokens,
      completion_tokens: args.completionTokens,
      cost_usd: args.costUsd,
      cache_read_tokens: args.cacheReadTokens,
      cache_creation_tokens: args.cacheCreationTokens,
      created_at: now,
    })

    const conversation = await conversationByAppId(ctx, args.conversationId)
    if (conversation) {
      await ctx.db.patch(conversation._id, {
        prompt_tokens_total: conversation.prompt_tokens_total + args.promptTokens,
        completion_tokens_total:
          conversation.completion_tokens_total + args.completionTokens,
        cost_usd_total: conversation.cost_usd_total + args.costUsd,
        cache_read_tokens_total:
          conversation.cache_read_tokens_total + args.cacheReadTokens,
        cache_creation_tokens_total:
          conversation.cache_creation_tokens_total + args.cacheCreationTokens,
        updated_at: now,
      })
    }

    const fresh = await ctx.db.get(docId)
    return toMessageRow(fresh!)
  },
})

/**
 * Overwrite one message's token/cost totals AND propagate the new values onto
 * the parent conversation totals + the `context_tokens` snapshot, in ONE atomic
 * mutation (§3 #16). The message row started at zero in `appendMessage`, so the
 * conversation totals gain exactly the supplied amounts. No-op (returns `null`)
 * when the message has vanished (cleanup race).
 */
export const updateMessageTokens = mutation({
  args: {
    messageId: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsd: v.number(),
    cacheReadTokens: v.number(),
    cacheCreationTokens: v.number(),
    contextTokens: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query('ai_messages')
      .withIndex('by_app_id', (q) => q.eq('id', args.messageId))
      .unique()
    if (!message) return null

    await ctx.db.patch(message._id, {
      prompt_tokens: args.promptTokens,
      completion_tokens: args.completionTokens,
      cost_usd: args.costUsd,
      cache_read_tokens: args.cacheReadTokens,
      cache_creation_tokens: args.cacheCreationTokens,
    })

    const conversation = await conversationByAppId(ctx, message.conversation_id)
    if (conversation) {
      await ctx.db.patch(conversation._id, {
        prompt_tokens_total: conversation.prompt_tokens_total + args.promptTokens,
        completion_tokens_total:
          conversation.completion_tokens_total + args.completionTokens,
        cost_usd_total: conversation.cost_usd_total + args.costUsd,
        cache_read_tokens_total:
          conversation.cache_read_tokens_total + args.cacheReadTokens,
        cache_creation_tokens_total:
          conversation.cache_creation_tokens_total + args.cacheCreationTokens,
        context_tokens: args.contextTokens,
        updated_at: new Date().toISOString(),
      })
    }
    return null
  },
})

// ---------------------------------------------------------------------------
// Purge — one atomic mutation (§3 #15, explicit cascade)
// ---------------------------------------------------------------------------

/**
 * Hard-delete every soft-deleted conversation whose `deleted_at` is older than
 * `cutoffIso`, AND its messages (Convex has no cascade — children are deleted
 * explicitly). Returns the number of CONVERSATIONS purged (counted before
 * delete), matching the old transaction's `count(*)` return — not the raw row
 * count, which would include the cascaded message deletions.
 */
export const purgeSoftDeleted = mutation({
  args: { cutoffIso: v.string() },
  returns: v.number(),
  handler: async (ctx, { cutoffIso }) => {
    // `by_deleted` is ordered (null < strings); `gt('')` selects every
    // non-null `deleted_at` (all real ISO timestamps sort above the empty
    // string), then the JS filter applies the `< cutoff` window.
    const candidates = await ctx.db
      .query('ai_conversations')
      .withIndex('by_deleted', (q) => q.gt('deleted_at', ''))
      .collect()
    const toPurge = candidates.filter(
      (c) => c.deleted_at !== null && c.deleted_at < cutoffIso,
    )

    for (const conversation of toPurge) {
      const messages = await ctx.db
        .query('ai_messages')
        .withIndex('by_conversation_position', (q) =>
          q.eq('conversation_id', conversation.id),
        )
        .collect()
      for (const message of messages) await ctx.db.delete(message._id)
      await ctx.db.delete(conversation._id)
    }
    return toPurge.length
  },
})
