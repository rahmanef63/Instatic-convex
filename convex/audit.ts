/**
 * Audit-event trail — Convex functions.
 *
 * The Convex half of the `audit_events` domain. The thin repository adapter
 * (`server/repositories/audit.ts`) marshals args into these and keeps all the
 * label/metadata shaping on the Bun side — the TypeBox metadata
 * normalization (`compiledCheck`/`compiledDecode`) must not run in the Convex
 * V8 runtime, mirroring the `data_rows` hydration split
 * (docs/CONVEX-MIGRATION.md §2, §4.2).
 *
 * Conventions:
 * - `create` is an append-only insert: the nanoid `id` and the SQL
 *   `created_at` column default are both generated inside the mutation.
 *   `metadata` is stored as the opaque `metadata_json` string (§6), mirroring
 *   the old SQLite `*_json` auto-stringify and the PG `default '{}'`.
 * - `listEvents` is the SQL `order by created_at desc limit ?` read. It also
 *   returns the two label-source tables (`users`, `roles`) in full — exactly
 *   the two `select … from users` / `from roles` scans the SQL `listAuditEvents`
 *   issued — so the repository can hand-assemble actor/target/metadata labels
 *   (the JOIN → JS merge, §4.2). `metadata_json` is parsed back into the object
 *   the repository's `normalizeMetadata` expects (it is never re-parsed there).
 * - Convex `_id` never leaks out. Every function declares both `args` AND
 *   `returns` validators.
 *
 * @see server/repositories/audit.ts — the thin adapter that calls these
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query } from './_generated/server'

const nullableString = v.union(v.null(), v.string())

/** The raw audit-event row the repository's `rowToAuditEvent` consumes. */
const auditEventRowValidator = v.object({
  id: v.string(),
  actor_user_id: nullableString,
  action: v.string(),
  target_type: nullableString,
  target_id: nullableString,
  metadata_json: v.any(),
  ip_address: nullableString,
  user_agent: nullableString,
  created_at: v.string(),
})

/**
 * Insert one audit event. `metadata` is the already-normalized record the
 * caller passes (`{}` when absent); it is stringified into `metadata_json`.
 */
export const create = mutation({
  args: {
    actorUserId: nullableString,
    action: v.string(),
    targetType: nullableString,
    targetId: nullableString,
    metadata: v.any(),
    ipAddress: nullableString,
    userAgent: nullableString,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('audit_events', {
      id: nanoid(),
      actor_user_id: args.actorUserId,
      action: args.action,
      target_type: args.targetType,
      target_id: args.targetId,
      metadata_json: JSON.stringify(args.metadata),
      ip_address: args.ipAddress,
      user_agent: args.userAgent,
      created_at: new Date().toISOString(),
    })
    return null
  },
})

/**
 * The newest `limit` audit events (created_at desc), plus the label-source
 * tables. The `by_created` index supplies the ordering; the repository merges
 * `users` / `roles` into actor/target/metadata labels in JS.
 */
export const listEvents = query({
  args: { limit: v.number() },
  returns: v.object({
    events: v.array(auditEventRowValidator),
    users: v.array(
      v.object({ id: v.string(), email: v.string(), display_name: v.string() }),
    ),
    roles: v.array(v.object({ id: v.string(), name: v.string() })),
  }),
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query('audit_events')
      .withIndex('by_created')
      .order('desc')
      .take(limit)

    const events = rows.map((row) => ({
      id: row.id,
      actor_user_id: row.actor_user_id,
      action: row.action,
      target_type: row.target_type,
      target_id: row.target_id,
      metadata_json: JSON.parse(row.metadata_json) as unknown,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      created_at: row.created_at,
    }))

    const userRows = await ctx.db.query('users').collect()
    const users = userRows.map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
    }))

    const roleRows = await ctx.db.query('roles').collect()
    const roles = roleRows.map((r) => ({ id: r.id, name: r.name }))

    return { events, users, roles }
  },
})
