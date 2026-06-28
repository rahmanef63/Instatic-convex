/**
 * Login-attempt audit trail — Convex functions.
 *
 * This is the Convex half of the `login_attempts` domain; the thin repository
 * adapter (`server/repositories/loginAttempts.ts`) marshals args into these and
 * returns their results unchanged. All real logic lives here: id + timestamp
 * generation, the `attempted_at desc` ordering, and the activity-feed union.
 *
 * Conventions this slice establishes (see docs/CONVEX-MIGRATION.md §2, §4):
 * - App identity is the nanoid `id`, generated here on insert (mirrors the old
 *   `${nanoid()}` default). `attempted_at` is set here (replaces the SQL
 *   `current_timestamp` column default). Convex `_id` never leaks out.
 * - Every function declares `args` AND `returns` validators from convex/values.
 * - Reads return the camelCase domain shape the repository already exposes, so
 *   the repository is a pure pass-through (no row→object mapper left in it).
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query } from './_generated/server'
import type { Doc } from './_generated/dataModel'

const resultValidator = v.union(
  v.literal('success'),
  v.literal('bad_password'),
  v.literal('no_user'),
  v.literal('account_disabled'),
  v.literal('locked'),
  v.literal('rate_limited'),
  v.literal('mfa_failed'),
)

/** The camelCase shape every read returns — matches the repository's `LoginAttempt`. */
const attemptValidator = v.object({
  id: v.string(),
  attemptedAt: v.string(),
  emailNorm: v.union(v.null(), v.string()),
  ipAddress: v.union(v.null(), v.string()),
  userAgent: v.union(v.null(), v.string()),
  userId: v.union(v.null(), v.string()),
  result: resultValidator,
})

function toAttempt(row: Doc<'login_attempts'>) {
  return {
    id: row.id,
    attemptedAt: row.attempted_at,
    emailNorm: row.email_norm,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    userId: row.user_id,
    result: row.result,
  }
}

/** Append one attempt. Generates the app `id` and `attempted_at` here. */
export const record = mutation({
  args: {
    emailNorm: v.union(v.null(), v.string()),
    ipAddress: v.union(v.null(), v.string()),
    userAgent: v.union(v.null(), v.string()),
    userId: v.union(v.null(), v.string()),
    result: resultValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('login_attempts', {
      id: nanoid(),
      attempted_at: new Date().toISOString(),
      email_norm: args.emailNorm,
      ip_address: args.ipAddress,
      user_agent: args.userAgent,
      user_id: args.userId,
      result: args.result,
    })
    return null
  },
})

/** Most-recent `limit` attempts for a known user, newest first. */
export const listForUser = query({
  args: { userId: v.string(), limit: v.number() },
  returns: v.array(attemptValidator),
  handler: async (ctx, { userId, limit }) => {
    const rows = await ctx.db
      .query('login_attempts')
      .withIndex('by_user_attempted', (q) => q.eq('user_id', userId))
      .order('desc')
      .take(limit)
    return rows.map(toAttempt)
  },
})

/**
 * Per-account activity feed: rows for this `userId` UNION rows that mention this
 * `emailNorm` but were never associated to a user (`user_id IS NULL`). The SQL
 * `OR` over a single index has no Convex equivalent, so we fetch each branch by
 * its own index, merge, sort by recency, and slice — the documented
 * "candidate set by index, combine in JS" pattern (§4.2/§4.4).
 *
 * Note: the email branch is bounded to the most-recent `limit` rows before the
 * `user_id IS NULL` filter, so a feed with very high non-null volume could miss
 * older anonymous rows. Acceptable at self-hosted per-account scale.
 */
export const listActivityForUser = query({
  args: { userId: v.string(), emailNorm: v.string(), limit: v.number() },
  returns: v.array(attemptValidator),
  handler: async (ctx, { userId, emailNorm, limit }) => {
    const byUser = await ctx.db
      .query('login_attempts')
      .withIndex('by_user_attempted', (q) => q.eq('user_id', userId))
      .order('desc')
      .take(limit)
    const byEmail = await ctx.db
      .query('login_attempts')
      .withIndex('by_email_attempted', (q) => q.eq('email_norm', emailNorm))
      .order('desc')
      .take(limit)

    const merged = new Map<string, Doc<'login_attempts'>>()
    for (const row of byUser) merged.set(row.id, row)
    for (const row of byEmail) if (row.user_id === null) merged.set(row.id, row)

    const feed = [...merged.values()]
      .sort((a, b) =>
        a.attempted_at < b.attempted_at ? 1 : a.attempted_at > b.attempted_at ? -1 : 0,
      )
      .slice(0, limit)
    return feed.map(toAttempt)
  },
})

/** Most-recent `limit` attempts from a single IP, newest first. */
export const listForIp = query({
  args: { ipAddress: v.string(), limit: v.number() },
  returns: v.array(attemptValidator),
  handler: async (ctx, { ipAddress, limit }) => {
    const rows = await ctx.db
      .query('login_attempts')
      .withIndex('by_ip_attempted', (q) => q.eq('ip_address', ipAddress))
      .order('desc')
      .take(limit)
    return rows.map(toAttempt)
  },
})
