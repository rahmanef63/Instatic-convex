/**
 * AI usage rollups — the Convex read behind the `/admin/ai` Audit tab and the
 * dashboard "AI usage this month" widget.
 *
 * The five rollups (`getUsageTotals` / `getUsageByUser` / `getUsageByScope` /
 * `getUsageByModel` / `getUsageByDay` in `server/ai/audit/store.ts`) all derive
 * from the SAME per-message ledger. Rather than five aggregate queries, this
 * module exposes ONE query — `enrichedMessagesSince` — that returns every
 * `ai_messages` row in the window joined to its conversation (scope, user,
 * model, credential provider). The repository sums/buckets those rows Bun-side,
 * exactly as `getUsageByDay` already did for the calendar histogram (the
 * grouping convention SQL never owned).
 *
 * Joins, mirroring the old SQL:
 *   - `ai_messages` → `ai_conversations` is an INNER join: a message whose
 *     conversation vanished is dropped (the SQL `join ai_conversations`).
 *   - `ai_conversations` → `users` is a LEFT join: `email` / `display_name`
 *     are `null` for a deleted user (label falls back to the id Bun-side).
 *   - `ai_conversations` → `ai_provider_credentials` is a LEFT join:
 *     `provider_id` is `'unknown'` when the credential row was deleted
 *     mid-window or the conversation never carried one (the SQL
 *     `coalesce(cred.provider_id, 'unknown')`).
 *
 * The window is scanned by the `by_created` index on `ai_messages.created_at`
 * (the per-call timestamp — `ai_conversations.created_at` would over-count the
 * first day of a long-running chat).
 *
 * @see server/ai/audit/store.ts — the repository that aggregates these rows
 */

import { v } from 'convex/values'
import { query, type QueryCtx } from './_generated/server'

const scopeValidator = v.union(
  v.literal('site'),
  v.literal('content'),
  v.literal('data'),
  v.literal('plugin'),
)

/**
 * One per-message ledger row enriched with the conversation/user/credential
 * fields the rollups group by. Token/cost fields are the per-call amounts.
 */
const enrichedMessageValidator = v.object({
  created_at: v.string(),
  conversation_id: v.string(),
  prompt_tokens: v.number(),
  completion_tokens: v.number(),
  cost_usd: v.number(),
  cache_read_tokens: v.number(),
  cache_creation_tokens: v.number(),
  user_id: v.string(),
  scope: scopeValidator,
  model_id: v.string(),
  email: v.union(v.null(), v.string()),
  display_name: v.union(v.null(), v.string()),
  provider_id: v.string(),
})

async function conversationByAppId(ctx: QueryCtx, id: string) {
  return ctx.db
    .query('ai_conversations')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

async function userByAppId(ctx: QueryCtx, id: string) {
  return ctx.db
    .query('users')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

async function credentialByAppId(ctx: QueryCtx, id: string) {
  return ctx.db
    .query('ai_provider_credentials')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

/**
 * Every message created at/after `sinceIso`, joined to its conversation (inner)
 * + user (left) + credential provider (left). Per-conversation lookups are
 * memoised so a busy chat is resolved once, not once per message.
 */
export const enrichedMessagesSince = query({
  args: { sinceIso: v.string() },
  returns: v.array(enrichedMessageValidator),
  handler: async (ctx, { sinceIso }) => {
    const messages = await ctx.db
      .query('ai_messages')
      .withIndex('by_created', (q) => q.gte('created_at', sinceIso))
      .collect()

    const convCache = new Map<
      string,
      { user_id: string; scope: 'site' | 'content' | 'data' | 'plugin'; model_id: string; provider_id: string; email: string | null; display_name: string | null } | null
    >()

    const out: Array<typeof enrichedMessageValidator['type']> = []
    for (const m of messages) {
      let joined = convCache.get(m.conversation_id)
      if (joined === undefined) {
        const conversation = await conversationByAppId(ctx, m.conversation_id)
        if (!conversation) {
          convCache.set(m.conversation_id, null)
          joined = null
        } else {
          const user = await userByAppId(ctx, conversation.user_id)
          const credential = conversation.credential_id
            ? await credentialByAppId(ctx, conversation.credential_id)
            : null
          joined = {
            user_id: conversation.user_id,
            scope: conversation.scope,
            model_id: conversation.model_id,
            provider_id: credential?.provider_id ?? 'unknown',
            email: user?.email ?? null,
            display_name: user?.display_name ?? null,
          }
          convCache.set(m.conversation_id, joined)
        }
      }
      if (!joined) continue
      out.push({
        created_at: m.created_at,
        conversation_id: m.conversation_id,
        prompt_tokens: m.prompt_tokens,
        completion_tokens: m.completion_tokens,
        cost_usd: m.cost_usd,
        cache_read_tokens: m.cache_read_tokens,
        cache_creation_tokens: m.cache_creation_tokens,
        user_id: joined.user_id,
        scope: joined.scope,
        model_id: joined.model_id,
        email: joined.email,
        display_name: joined.display_name,
        provider_id: joined.provider_id,
      })
    }
    return out
  },
})
