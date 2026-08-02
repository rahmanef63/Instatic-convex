/**
 * Plugin scheduled jobs — Convex functions for `plugin_schedules` (one row per
 * (plugin_id, schedule_id): cadence + lease + last-run state) and the
 * append-only `plugin_schedule_runs` history.
 *
 * The Convex half of the scheduler persistence; the thin repository adapter
 * (`server/repositories/pluginSchedules.ts`) marshals args into these and maps
 * the rows back into the frozen `PluginSchedule` / run shapes
 * (docs/CONVEX-MIGRATION.md §2). `cadence_json` stays an opaque `v.string()` at
 * rest (§6), parsed in the repository.
 *
 * THE HARD CASE — advisory-lock leader election → atomic claim-by-write
 * (docs/CONVEX-MIGRATION.md §4.1). The SQL scheduler combined a
 * `pg_try_advisory_lock` HA leader gate with a per-row `running_token` flip.
 * Convex has no advisory locks and **needs none**: it is the single backend and
 * its mutations are serializable, so the per-row claim is the only coordination
 * required. `tryClaim` reads the row and atomically flips `running_token` /
 * `lock_until` only when the existing lease is free — two concurrent claimants
 * serialise and the second sees the lease taken and no-ops. `advisoryLock.ts`
 * is never called from here; it is retired with the SQL layer (§7).
 *
 * Upserts (`upsert`) are read-by-index → patch-or-insert (§4.6, no `ON
 * CONFLICT`), preserving last-run state + the operator/`paused` flag across
 * re-registration exactly as the SQL `do update set` did. `selectDue` replaces
 * the SQL `join installed_plugins` with a per-row index lookup of the owning
 * plugin's `enabled` flag (§4.2/§4.4). Every db.transaction-equivalent here was
 * a single statement; each collapses to one atomic mutation.
 *
 * Timestamps that the SQL stamped via column defaults (`created_at`,
 * `updated_at`, `claimed_at`) are stamped here; all other times are passed in
 * by the caller (the scheduler computes them). Convex `_id` never leaks out.
 * Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/pluginSchedules.ts — the thin repository adapter
 * @see server/plugins/scheduler.ts             — the tick loop that drives these
 */

import { v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const nullableString = v.union(v.null(), v.string())
const nullableNumber = v.union(v.null(), v.number())

const overlapValidator = v.union(
  v.literal('skip'),
  v.literal('queue'),
  v.literal('parallel'),
)

const runStatusValidator = v.union(
  v.literal('ok'),
  v.literal('error'),
  v.literal('timeout'),
  v.literal('never_run'),
)

const lastStatusValidator = v.union(v.null(), runStatusValidator)

/** The raw `plugin_schedules` row consumed by the repository's `mapSchedule`. */
const scheduleRowValidator = v.object({
  plugin_id: v.string(),
  schedule_id: v.string(),
  cadence_json: v.string(),
  overlap: overlapValidator,
  max_duration_ms: v.number(),
  enabled: v.boolean(),
  paused: v.boolean(),
  consecutive_failures: v.number(),
  last_run_at: nullableString,
  last_finished_at: nullableString,
  last_status: lastStatusValidator,
  last_error: nullableString,
  last_duration_ms: nullableNumber,
  next_run_at: v.string(),
  running_token: nullableString,
  lock_until: nullableString,
  claimed_at: nullableString,
  created_at: v.string(),
  updated_at: v.string(),
})

/** The raw `plugin_schedule_runs` row consumed by the repository's `mapRun`. */
const scheduleRunRowValidator = v.object({
  id: v.string(),
  plugin_id: v.string(),
  schedule_id: v.string(),
  started_at: v.string(),
  finished_at: nullableString,
  status: runStatusValidator,
  error: nullableString,
  duration_ms: nullableNumber,
  triggered_by: v.union(v.literal('tick'), v.literal('run-now')),
})

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function scheduleByKey(ctx: QueryCtx | MutationCtx, pluginId: string, scheduleId: string) {
  return ctx.db
    .query('plugin_schedules')
    .withIndex('by_plugin_schedule', (q) =>
      q.eq('plugin_id', pluginId).eq('schedule_id', scheduleId),
    )
    .unique()
}

function toScheduleRow(row: Doc<'plugin_schedules'>) {
  return {
    plugin_id: row.plugin_id,
    schedule_id: row.schedule_id,
    cadence_json: row.cadence_json,
    overlap: row.overlap,
    max_duration_ms: row.max_duration_ms,
    enabled: row.enabled,
    paused: row.paused,
    consecutive_failures: row.consecutive_failures,
    last_run_at: row.last_run_at,
    last_finished_at: row.last_finished_at,
    last_status: row.last_status,
    last_error: row.last_error,
    last_duration_ms: row.last_duration_ms,
    next_run_at: row.next_run_at,
    running_token: row.running_token,
    lock_until: row.lock_until,
    claimed_at: row.claimed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toRunRow(row: Doc<'plugin_schedule_runs'>) {
  return {
    id: row.id,
    plugin_id: row.plugin_id,
    schedule_id: row.schedule_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: row.status,
    error: row.error,
    duration_ms: row.duration_ms,
    triggered_by: row.triggered_by,
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Upsert a schedule (the SQL `on conflict (plugin_id, schedule_id) do update`,
 * §4.6). Re-registration overwrites cadence / overlap / max_duration / enabled
 * / next_run_at and re-stamps `claimed_at`, but PRESERVES last-run state and the
 * operator/`paused` flag — exactly the columns the SQL `do update set` left out.
 * `created_at` / `updated_at` / `claimed_at` are stamped here.
 */
export const upsert = mutation({
  args: {
    pluginId: v.string(),
    scheduleId: v.string(),
    cadenceJson: v.string(),
    overlap: overlapValidator,
    maxDurationMs: v.number(),
    nextRunAt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const existing = await scheduleByKey(ctx, args.pluginId, args.scheduleId)
    if (existing) {
      await ctx.db.patch(existing._id, {
        cadence_json: args.cadenceJson,
        overlap: args.overlap,
        max_duration_ms: args.maxDurationMs,
        enabled: true,
        next_run_at: args.nextRunAt,
        claimed_at: now,
        updated_at: now,
      })
      return null
    }
    await ctx.db.insert('plugin_schedules', {
      plugin_id: args.pluginId,
      schedule_id: args.scheduleId,
      cadence_json: args.cadenceJson,
      overlap: args.overlap,
      max_duration_ms: args.maxDurationMs,
      enabled: true,
      paused: false,
      consecutive_failures: 0,
      last_run_at: null,
      last_finished_at: null,
      last_status: null,
      last_error: null,
      last_duration_ms: null,
      next_run_at: args.nextRunAt,
      running_token: null,
      lock_until: null,
      claimed_at: now,
      created_at: now,
      updated_at: now,
    })
    return null
  },
})

/** Soft-disable a schedule (registration cancel). No-op if absent. */
export const disable = mutation({
  args: { pluginId: v.string(), scheduleId: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId, scheduleId }) => {
    const row = await scheduleByKey(ctx, pluginId, scheduleId)
    if (!row) return null
    await ctx.db.patch(row._id, { enabled: false, updated_at: new Date().toISOString() })
    return null
  },
})

/**
 * Ghost sweep — disable every still-enabled schedule of `pluginId` whose
 * `claimed_at` predates the latest `activate()` pass (so it was not
 * re-registered this boot). ISO-8601 strings compare correctly as text.
 */
export const disableNotReclaimedSince = mutation({
  args: { pluginId: v.string(), activationStartedAtIso: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId, activationStartedAtIso }) => {
    const now = new Date().toISOString()
    const rows = await ctx.db
      .query('plugin_schedules')
      .withIndex('by_plugin', (q) => q.eq('plugin_id', pluginId))
      .collect()
    for (const row of rows) {
      if (!row.enabled) continue
      if (row.claimed_at !== null && row.claimed_at >= activationStartedAtIso) continue
      await ctx.db.patch(row._id, { enabled: false, updated_at: now })
    }
    return null
  },
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All schedules of one plugin, ordered by schedule id. */
export const listForPlugin = query({
  args: { pluginId: v.string() },
  returns: v.array(scheduleRowValidator),
  handler: async (ctx, { pluginId }) => {
    const rows = await ctx.db
      .query('plugin_schedules')
      .withIndex('by_plugin', (q) => q.eq('plugin_id', pluginId))
      .collect()
    rows.sort((a, b) =>
      a.schedule_id < b.schedule_id ? -1 : a.schedule_id > b.schedule_id ? 1 : 0,
    )
    return rows.map(toScheduleRow)
  },
})

/** One schedule by (plugin_id, schedule_id), or `null`. */
export const get = query({
  args: { pluginId: v.string(), scheduleId: v.string() },
  returns: v.union(v.null(), scheduleRowValidator),
  handler: async (ctx, { pluginId, scheduleId }) => {
    const row = await scheduleByKey(ctx, pluginId, scheduleId)
    return row ? toScheduleRow(row) : null
  },
})

/**
 * Up to `limit` schedules ready to fire now: registered (`enabled`), not
 * `paused`, lease free, and owned by an enabled plugin — oldest `next_run_at`
 * first. The SQL `join installed_plugins` becomes a per-row index lookup of the
 * owning plugin (§4.2/§4.4).
 */
export const selectDue = query({
  args: { nowIso: v.string(), limit: v.number() },
  returns: v.array(scheduleRowValidator),
  handler: async (ctx, { nowIso, limit }) => {
    const candidates = await ctx.db
      .query('plugin_schedules')
      .withIndex('by_due', (q) =>
        q.eq('enabled', true).eq('paused', false).lte('next_run_at', nowIso),
      )
      .collect()

    const ready: Doc<'plugin_schedules'>[] = []
    const pluginEnabled = new Map<string, boolean>()
    for (const row of candidates) {
      if (row.lock_until !== null && row.lock_until > nowIso) continue
      let enabled = pluginEnabled.get(row.plugin_id)
      if (enabled === undefined) {
        const plugin = await ctx.db
          .query('installed_plugins')
          .withIndex('by_app_id', (q) => q.eq('id', row.plugin_id))
          .unique()
        enabled = plugin ? plugin.enabled : false
        pluginEnabled.set(row.plugin_id, enabled)
      }
      if (enabled) ready.push(row)
    }

    ready.sort((a, b) =>
      a.next_run_at < b.next_run_at ? -1 : a.next_run_at > b.next_run_at ? 1 : 0,
    )
    return ready.slice(0, limit).map(toScheduleRow)
  },
})

// ---------------------------------------------------------------------------
// Atomic claim + run lifecycle (§4.1 — replaces the advisory lock)
// ---------------------------------------------------------------------------

/**
 * Atomically reserve a schedule for THIS tick by flipping `running_token` /
 * `lock_until`, but only when the existing lease is free (null token, or an
 * expired `lock_until`) and the schedule is still `enabled`. Convex
 * serializability makes two concurrent claimants race safely: exactly one
 * patch wins, the other re-reads a held lease and returns `false`. This is the
 * documented replacement for `pg_try_advisory_lock` (docs/CONVEX-MIGRATION.md
 * §4.1). `paused` is deliberately NOT re-checked here — the tick already
 * filtered it in `selectDue`, while admin "Run now" must still claim a paused
 * schedule.
 */
export const tryClaim = mutation({
  args: {
    pluginId: v.string(),
    scheduleId: v.string(),
    token: v.string(),
    lockUntilIso: v.string(),
    nowIso: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await scheduleByKey(ctx, args.pluginId, args.scheduleId)
    if (!row || !row.enabled) return false
    const leaseFree =
      row.running_token === null || (row.lock_until !== null && row.lock_until <= args.nowIso)
    if (!leaseFree) return false
    await ctx.db.patch(row._id, {
      running_token: args.token,
      lock_until: args.lockUntilIso,
      updated_at: args.nowIso,
    })
    return true
  },
})

/**
 * Release the lease and record a run's outcome — guarded by `running_token ===
 * token` so a stale tick can't overwrite a re-claimed row. `resetFailures`
 * clears the failure counter and coalesces `last_run_at`; otherwise the counter
 * is incremented.
 */
export const recordRunOutcome = mutation({
  args: {
    pluginId: v.string(),
    scheduleId: v.string(),
    token: v.string(),
    nowIso: v.string(),
    status: runStatusValidator,
    error: nullableString,
    durationMs: v.number(),
    nextRunAt: v.string(),
    resetFailures: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await scheduleByKey(ctx, args.pluginId, args.scheduleId)
    if (!row || row.running_token !== args.token) return null
    if (args.resetFailures) {
      await ctx.db.patch(row._id, {
        running_token: null,
        lock_until: null,
        last_run_at: row.last_run_at ?? args.nowIso,
        last_finished_at: args.nowIso,
        last_status: args.status,
        last_error: args.error,
        last_duration_ms: args.durationMs,
        next_run_at: args.nextRunAt,
        consecutive_failures: 0,
        updated_at: args.nowIso,
      })
      return null
    }
    await ctx.db.patch(row._id, {
      running_token: null,
      lock_until: null,
      last_finished_at: args.nowIso,
      last_status: args.status,
      last_error: args.error,
      last_duration_ms: args.durationMs,
      next_run_at: args.nextRunAt,
      consecutive_failures: row.consecutive_failures + 1,
      updated_at: args.nowIso,
    })
    return null
  },
})

/** Stamp `last_run_at` before the handler completes (admin "running now" signal). */
export const markRunStarted = mutation({
  args: { pluginId: v.string(), scheduleId: v.string(), startedAtIso: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId, scheduleId, startedAtIso }) => {
    const row = await scheduleByKey(ctx, pluginId, scheduleId)
    if (!row) return null
    await ctx.db.patch(row._id, { last_run_at: startedAtIso, updated_at: startedAtIso })
    return null
  },
})

/** Pause a schedule (operator or failure-cap). Independent of `enabled`. */
export const pause = mutation({
  args: { pluginId: v.string(), scheduleId: v.string(), pausedAtIso: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId, scheduleId, pausedAtIso }) => {
    const row = await scheduleByKey(ctx, pluginId, scheduleId)
    if (!row) return null
    await ctx.db.patch(row._id, { paused: true, updated_at: pausedAtIso })
    return null
  },
})

/** Clear an operator/failure pause and reset the failure counter. */
export const resume = mutation({
  args: { pluginId: v.string(), scheduleId: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId, scheduleId }) => {
    const row = await scheduleByKey(ctx, pluginId, scheduleId)
    if (!row) return null
    await ctx.db.patch(row._id, {
      paused: false,
      consecutive_failures: 0,
      updated_at: new Date().toISOString(),
    })
    return null
  },
})

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

/** Insert a run row at fire time (status `never_run` until finalized). */
export const insertRun = mutation({
  args: {
    id: v.string(),
    pluginId: v.string(),
    scheduleId: v.string(),
    startedAt: v.string(),
    triggeredBy: v.union(v.literal('tick'), v.literal('run-now')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('plugin_schedule_runs', {
      id: args.id,
      plugin_id: args.pluginId,
      schedule_id: args.scheduleId,
      started_at: args.startedAt,
      finished_at: null,
      status: 'never_run',
      error: null,
      duration_ms: null,
      triggered_by: args.triggeredBy,
    })
    return null
  },
})

/** Finalize a run row with its outcome. No-op if the run id is gone. */
export const finalizeRun = mutation({
  args: {
    runId: v.string(),
    finishedAt: v.string(),
    status: runStatusValidator,
    error: nullableString,
    durationMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('plugin_schedule_runs')
      .withIndex('by_app_id', (q) => q.eq('id', args.runId))
      .unique()
    if (!row) return null
    await ctx.db.patch(row._id, {
      finished_at: args.finishedAt,
      status: args.status,
      error: args.error,
      duration_ms: args.durationMs,
    })
    return null
  },
})

/** Recent runs for one schedule, newest first. */
export const listRecentRuns = query({
  args: { pluginId: v.string(), scheduleId: v.string(), limit: v.number() },
  returns: v.array(scheduleRunRowValidator),
  handler: async (ctx, { pluginId, scheduleId, limit }) => {
    const rows = await ctx.db
      .query('plugin_schedule_runs')
      .withIndex('by_lookup', (q) =>
        q.eq('plugin_id', pluginId).eq('schedule_id', scheduleId),
      )
      .collect()
    rows.sort((a, b) =>
      a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
    )
    return rows.slice(0, limit).map(toRunRow)
  },
})

/**
 * Trim run history to `keepPerSchedule` rows per (plugin_id, schedule_id). The
 * SQL did this with a correlated subquery; here we group in JS and delete the
 * overflow (O(N) over the runs table — bounded CMS scale).
 */
export const trimRunHistory = mutation({
  args: { keepPerSchedule: v.number() },
  returns: v.null(),
  handler: async (ctx, { keepPerSchedule }) => {
    const all = await ctx.db.query('plugin_schedule_runs').collect()
    const groups = new Map<string, Doc<'plugin_schedule_runs'>[]>()
    for (const row of all) {
      const key = `${row.plugin_id} ${row.schedule_id}`
      const list = groups.get(key)
      if (list) list.push(row)
      else groups.set(key, [row])
    }
    for (const list of groups.values()) {
      if (list.length <= keepPerSchedule) continue
      list.sort((a, b) =>
        a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
      )
      for (const stale of list.slice(keepPerSchedule)) await ctx.db.delete(stale._id)
    }
    return null
  },
})

/** Drop the full run history for one plugin (uninstall — no FK cascade). */
export const clearRunsForPlugin = mutation({
  args: { pluginId: v.string() },
  returns: v.null(),
  handler: async (ctx, { pluginId }) => {
    const rows = await ctx.db
      .query('plugin_schedule_runs')
      .withIndex('by_plugin', (q) => q.eq('plugin_id', pluginId))
      .collect()
    for (const row of rows) await ctx.db.delete(row._id)
    return null
  },
})
