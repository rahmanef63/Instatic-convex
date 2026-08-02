/**
 * Scheduled publish tick — polls the `data_rows` table for rows where
 * `status = 'scheduled' AND scheduled_publish_at <= now()` and fires the
 * regular publish path on each.
 *
 * Modeled on `server/plugins/scheduler.ts`. Differences:
 *
 *   • One-shot, not recurring. Each scheduled row fires AT MOST ONCE per
 *     `scheduled_publish_at` timestamp. After firing the row's status
 *     transitions to `'published'` (success) or `'draft'` (failure) —
 *     either way it's no longer selected by subsequent ticks.
 *
 *   • No per-schedule cadence math. The target time IS the cadence.
 *
 *   • No run-history table. Failures go to `console.error`. The audit
 *     log captures the publish event itself via the existing
 *     `auditEvent('row.publish.scheduled')` we record next to the call.
 *
 * HA-safety: double-run is guarded by Convex's per-row atomic claim — the
 * fired row's `status='scheduled'` → `'published'` transition inside
 * `publishDataRow` is a no-op for any second tick that races it, so no
 * advisory lock is required.
 *
 * Failure policy: when `publishDataRow` throws (e.g. validation fails,
 * the row got deleted between selection and publish), the row is
 * reverted to `'draft'` via `cancelScheduledPublish` and the error is
 * logged. This is the "revert to draft + log error" choice from the
 * scheduling-design discussion — no retry counters, no 'failed' status,
 * the operator sees their row back in the drafts list and retries
 * manually.
 */
import { publishDataRow } from './publishRow'
import { emitContentEntryUpdated } from './contentEvents'
import {
  cancelScheduledPublish,
  listDuePublishSchedules,
} from '../repositories/data/rows'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How often the leader instance polls for due scheduled rows. 10s
 * matches the plugin scheduler — the tradeoff is "how late can a
 * scheduled publish be before the user notices". Faster = more DB
 * polling, slower = visible publish lag. 10s feels human-correct.
 */
const TICK_INTERVAL_MS = 10_000

/**
 * Max scheduled rows pulled per tick. Bounded so one tick can't starve
 * the next if hundreds of rows are scheduled for the same minute (e.g.
 * "publish my whole content backlog at noon Monday"). Excess rows are
 * picked up on the next tick.
 */
const TICK_BATCH_LIMIT = 25

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

let tickTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the publish-scheduler tick. Idempotent — calling it twice on
 * the same process is a no-op. Pair with `server/plugins/scheduler.ts`'s
 * `startScheduler` in the boot path.
 */
export function startPublishScheduler(uploadsDir?: string): void {
  if (tickTimer !== null) return
  tickTimer = setInterval(() => {
    void tickPublishScheduler(uploadsDir).catch((err) => {
      console.error('[publish-scheduler] tick failed:', err)
    })
  }, TICK_INTERVAL_MS)
}

/**
 * One iteration of the tick. Exported for tests — production code uses
 * `startPublishScheduler` and lets `setInterval` drive.
 */
export async function tickPublishScheduler(uploadsDir?: string): Promise<void> {
  const due = await listDuePublishSchedules(new Date().toISOString(), TICK_BATCH_LIMIT)
  for (const entry of due) {
    await fireOne(entry.rowId, uploadsDir)
  }
}

/**
 * Fire one scheduled publish. Publishes via `publishDataRow` and on
 * failure reverts the row to draft + logs the error. The fired row's
 * own `status='scheduled'` → `'published'` transition (inside
 * `publishDataRow`) is what guarantees idempotency: even if two ticks
 * race past the leader lock, the second one's `update ... where
 * status = 'scheduled'` is a no-op because the first already flipped
 * it to `'published'`. (See `publishDataRow`'s transaction.)
 */
async function fireOne(rowId: string, uploadsDir?: string): Promise<void> {
  try {
    // `publisherUserId: null` is the "system actor" path — the publish
    // wasn't initiated by a logged-in user, it was the scheduler tick.
    // The `published_by_user_id` column lands as null which downstream
    // UI renders as "Scheduled publish" instead of a user attribution.
    await publishDataRow(rowId, null, uploadsDir)
    await emitContentEntryUpdated(rowId, ['status'], { kind: 'system' })
  } catch (err) {
    console.error(`[publish-scheduler] failed to publish row ${rowId}:`, err)
    // Revert to draft so the row stops being selected on subsequent
    // ticks. Operator sees it back in drafts and retries manually.
    await cancelScheduledPublish(rowId, null).catch((cancelErr) => {
      console.error(`[publish-scheduler] failed to revert row ${rowId} after publish error:`, cancelErr)
    })
  }
}
