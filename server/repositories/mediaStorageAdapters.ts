/**
 * Per-role media storage adapter election.
 *
 *   • One row per `MediaAssetRole` in `active_media_storage_adapter`.
 *   • `adapter_id = ''` means "use the built-in local-disk adapter".
 *   • A missing row defaults to `''` (local-disk).
 *
 * The host snapshots the elected adapter for a role AT THE START of an
 * upload and pins it for that operation's whole life — that prevents an
 * admin re-election race from mid-stream switching the backend.
 *
 * Read dispatch uses the asset row's `storage_adapter_id`, NOT the
 * currently-elected adapter. That way old assets keep resolving via the
 * adapter that actually wrote them even after an election change — see
 * `migrations-pg.ts:004_media_storage_adapters` for the column.
 */

import { isoDate } from '@core/utils/isoDate'
import type { MediaAssetRole } from '@core/plugin-sdk'
import { api, getConvex } from '../convex/client'

interface ElectedAdapterRow {
  role: string
  adapter_id: string
  elected_at: Date | string
  elected_by_user_id: string | null
}

interface ElectedAdapter {
  role: MediaAssetRole
  adapterId: string
  electedAt: string
  electedByUserId: string | null
}

function mapRow(row: ElectedAdapterRow): ElectedAdapter {
  return {
    role: row.role as MediaAssetRole,
    adapterId: row.adapter_id,
    electedAt: isoDate(row.elected_at),
    electedByUserId: row.elected_by_user_id,
  }
}

/**
 * Resolve the elected adapter id for a given role. Returns `''` (= local-disk)
 * when no row exists for the role — that's the post-fresh-install default.
 */
export async function getElectedAdapterId(
  role: MediaAssetRole,
): Promise<string> {
  return getConvex().query(api.mediaStorage.getElectedAdapterId, { role })
}

/**
 * Snapshot every elected adapter (all roles, including unset ones which
 * resolve to `''`). Used by the admin UI to render the election picker.
 */
export async function listElectedAdapters(): Promise<ElectedAdapter[]> {
  const rows = await getConvex().query(api.mediaStorage.listElectedAdapters, {})
  return rows.map(mapRow)
}

/**
 * Elect an adapter for a role. Empty `adapterId` resets to local-disk.
 * Idempotent: re-electing the same adapter for the same role refreshes
 * `elected_at` / `elected_by_user_id`.
 *
 * Upsert keyed by `role`.
 */
export async function electAdapter(
  role: MediaAssetRole,
  adapterId: string,
  userId: string | null,
): Promise<ElectedAdapter> {
  const row = await getConvex().mutation(api.mediaStorage.electAdapter, {
    role,
    adapterId,
    userId,
  })
  return mapRow(row)
}

/**
 * How many asset rows are written by a given adapter id. The admin uses
 * this to (a) display "this adapter owns 1,247 assets" in the picker, and
 * (b) block uninstalling a plugin whose adapter still has live rows.
 */
export async function countAssetsForAdapter(
  adapterId: string,
): Promise<number> {
  return getConvex().query(api.mediaStorage.countAssetsForAdapter, { adapterId })
}

// ---------------------------------------------------------------------------
// Variant delegate (Tier 3) — singleton election
// ---------------------------------------------------------------------------

export interface ElectedVariantDelegate {
  delegateId: string
  variantUrlTemplate: string
  widths: number[]
  formats: ReadonlyArray<'webp' | 'jpeg' | 'avif'>
  electedAt: string
  electedByUserId: string | null
}

interface VariantDelegateRow {
  delegate_id: string
  variant_url_template: string
  widths_json: unknown
  formats_json: unknown
  elected_at: Date | string
  elected_by_user_id: string | null
}

function parseWidths(value: unknown): number[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  return Array.isArray(raw)
    ? raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : []
}

const ALLOWED_VARIANT_FORMATS = new Set(['webp', 'jpeg', 'avif'])

function parseFormats(value: unknown): ReadonlyArray<'webp' | 'jpeg' | 'avif'> {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (f): f is 'webp' | 'jpeg' | 'avif' =>
      typeof f === 'string' && ALLOWED_VARIANT_FORMATS.has(f),
  )
}

function mapVariantDelegateRow(row: VariantDelegateRow): ElectedVariantDelegate {
  return {
    delegateId: row.delegate_id,
    variantUrlTemplate: row.variant_url_template,
    widths: parseWidths(row.widths_json),
    formats: parseFormats(row.formats_json),
    electedAt: isoDate(row.elected_at),
    electedByUserId: row.elected_by_user_id,
  }
}

/**
 * Returns the currently-elected variant delegate, or `null` when none is
 * elected (the host then falls back to the local sharp ladder).
 *
 * Singleton — the row's PRIMARY KEY constraint guarantees at most one
 * delegate is active per host.
 */
export async function getElectedVariantDelegate(): Promise<ElectedVariantDelegate | null> {
  const row = await getConvex().query(api.mediaStorage.getElectedVariantDelegate, {})
  return row ? mapVariantDelegateRow(row) : null
}

/**
 * Elect a variant delegate. The plugin first registers the delegate via
 * the SDK (`api.cms.media.registerVariantDelegate(...)`), and the admin
 * activates it through this row. Calling with `null` resets to the local
 * sharp ladder.
 */
export async function electVariantDelegate(
  delegate: Omit<ElectedVariantDelegate, 'electedAt' | 'electedByUserId'>,
  userId: string | null,
): Promise<ElectedVariantDelegate> {
  const row = await getConvex().mutation(api.mediaStorage.electVariantDelegate, {
    delegateId: delegate.delegateId,
    variantUrlTemplate: delegate.variantUrlTemplate,
    widths: [...delegate.widths],
    formats: [...delegate.formats],
    userId,
  })
  return mapVariantDelegateRow(row)
}

/**
 * Clear the elected delegate — host falls back to the local sharp ladder.
 */
export async function clearVariantDelegate(): Promise<void> {
  await getConvex().mutation(api.mediaStorage.clearVariantDelegate, {})
}
