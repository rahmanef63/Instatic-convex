/**
 * Repository helpers for the media-storage migration tool.
 *
 * Two surfaces:
 *
 *   • `countMigrationBacklog(...)` — given a (role, targetAdapterId),
 *     return how many rows / variants need to move. Powers the
 *     "Migrate N assets" badge in the storage admin panel.
 *
 *   • Iteration / update helpers used by the per-asset migration loop:
 *       - `listPendingOriginals` — paginated rows whose
 *         storage_adapter_id != target.
 *       - `listAssetsWithPendingVariants` — paginated rows that have at
 *         least one variant on a non-target adapter.
 *       - `updateAssetStorageLocation` — write the new storage_path /
 *         public_path / storage_adapter_id / externally_hosted onto a
 *         row after the destination upload succeeds.
 *       - `updateVariantStorageLocation` — same shape but for one
 *         variant entry inside a row's `variants_json`.
 *
 * All counts + lists exclude soft-deleted rows. The migration tool
 * intentionally skips Trash: anything in Trash is on its way out
 * (`hard-delete` purges the bytes anyway), so spending bandwidth moving
 * it across adapters would be wasted work.
 */

import type { MediaVariant } from './media'
import { api, getConvex } from '../convex/client'

export interface PendingOriginal {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  storageAdapterId: string
}

export interface PendingVariantContainer {
  /** Parent asset id. */
  id: string
  /** Parent's storagePath — used when uploading variants (as `variantOf`). */
  parentStoragePath: string
  /** Raw variants list (some entries may already be on the target). */
  variants: MediaVariant[]
}

function parseVariantsFromJson(value: unknown): MediaVariant[] {
  // Mirrors the parser in `repositories/media.ts:parseVariants` but
  // duplicated here to keep this module free of cross-imports past
  // the type. Old rows without storagePath/storageAdapterId fall back
  // to local-disk semantics — same canonical derivation.
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  if (!Array.isArray(raw)) return []
  const out: MediaVariant[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.width !== 'number' || typeof e.height !== 'number') continue
    if (typeof e.path !== 'string' || typeof e.sizeBytes !== 'number') continue
    if (e.format !== 'webp' && e.format !== 'jpeg' && e.format !== 'png' && e.format !== 'avif') continue
    const storagePath = typeof e.storagePath === 'string' && e.storagePath
      ? e.storagePath
      : e.path.startsWith('/uploads/')
        ? e.path.slice('/uploads/'.length)
        : e.path
    const storageAdapterId = typeof e.storageAdapterId === 'string' ? e.storageAdapterId : ''
    out.push({
      width: e.width,
      height: e.height,
      format: e.format,
      path: e.path,
      sizeBytes: e.sizeBytes,
      storagePath,
      storageAdapterId,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Backlog counts
// ---------------------------------------------------------------------------

interface MigrationBacklog {
  /** Total `media_assets` rows whose storage_adapter_id != target. */
  originals: number
  /**
   * Total VARIANT ENTRIES across all rows whose storageAdapterId != target.
   * Computed JS-side from `variants_json` because the value is a JSON blob
   * (no per-variant DB row exists). For sites with thousands of assets the
   * JS pass is still fast — variants per asset are bounded by the
   * `TARGET_WIDTHS` ladder plus the intrinsic rung (≤ 7).
   */
  variants: number
}

/**
 * Count how many rows / variants are still on a non-target adapter for
 * each role. Used by the storage admin panel to surface the
 * "Migrate N assets →" affordance.
 *
 * Caller passes a snapshot of the elected adapter ids per role
 * (target). Roles other than 'original' / 'variant' are reported as 0
 * in v1 — see the file-level comment in `mediaStorageMigration.ts` for
 * why avatar/font/plugin-pack are out of scope for now.
 */
export async function countMigrationBacklog(
  targets: { original: string; variant: string },
): Promise<MigrationBacklog> {
  // The Convex query returns the exact originals count plus every non-deleted
  // row's (non-empty) `variants_json` blob — exactly the data the SQL `select
  // variants_json …` pulled JS-side (`variants_json` is an opaque JSON string;
  // there is no per-variant DB row to count). We parse + count here with the
  // pure parser so the variant-entry semantics stay on the Bun side.
  const { originals, variantsJsons } = await getConvex().query(
    api.media.migrationBacklogData,
    { originalTarget: targets.original },
  )
  let variants = 0
  for (const json of variantsJsons) {
    const list = parseVariantsFromJson(json)
    for (const v of list) {
      if (v.storageAdapterId !== targets.variant) variants += 1
    }
  }
  return { originals, variants }
}

// ---------------------------------------------------------------------------
// Iteration — paginated lists for the migration loop
// ---------------------------------------------------------------------------

const PAGE_LIMIT = 50

export async function listPendingOriginals(
  targetAdapterId: string,
  cursor: string | null,
): Promise<{ items: PendingOriginal[]; nextCursor: string | null }> {
  // Cursor pagination keyed on id (lexicographic, the `by_app_id` range). Stable
  // and immune to "new row inserted during migration" skips that OFFSET-based
  // queries suffer from.
  const rows = await getConvex().query(api.media.listPendingOriginals, {
    targetAdapterId,
    cursor,
    limit: PAGE_LIMIT,
  })
  const items: PendingOriginal[] = rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    storagePath: row.storage_path,
    publicPath: row.public_path,
    storageAdapterId: row.storage_adapter_id,
  }))
  const nextCursor = items.length === PAGE_LIMIT ? items[items.length - 1].id : null
  return { items, nextCursor }
}

export async function listAssetsWithPendingVariants(
  targetAdapterId: string,
  cursor: string | null,
): Promise<{ items: PendingVariantContainer[]; nextCursor: string | null }> {
  // The Convex query returns the raw scanned page (non-deleted rows that have a
  // non-empty `variants_json`, ordered by id). We parse + filter here so the
  // variant-entry semantics stay on the Bun side.
  const rows = await getConvex().query(api.media.listAssetsWithPendingVariants, {
    cursor,
    limit: PAGE_LIMIT,
  })

  const items: PendingVariantContainer[] = []
  for (const row of rows) {
    const variants = parseVariantsFromJson(row.variants_json)
    const hasPending = variants.some((v) => v.storageAdapterId !== targetAdapterId)
    if (!hasPending) continue
    items.push({
      id: row.id,
      parentStoragePath: row.storage_path,
      variants,
    })
  }
  // Cursor advances on the underlying row scan, not on items kept.
  // Without that an entire batch of "all-already-migrated" rows would
  // loop forever — the loop must see the cursor move regardless.
  const nextCursor = rows.length === PAGE_LIMIT ? rows[rows.length - 1].id : null
  return { items, nextCursor }
}

// ---------------------------------------------------------------------------
// Per-asset mutation
// ---------------------------------------------------------------------------

/**
 * Update the storage-location columns on `media_assets` after a successful
 * destination upload. Mirrors `replaceMediaAssetBinary` but only touches
 * the storage fields — filename / mime_type / size_bytes stay untouched
 * because migration preserves the actual content.
 */
export async function updateAssetStorageLocation(
  id: string,
  input: {
    storagePath: string
    publicPath: string
    storageAdapterId: string
    externallyHosted: boolean
  },
): Promise<void> {
  await getConvex().mutation(api.media.updateAssetStorageLocation, {
    id,
    storagePath: input.storagePath,
    publicPath: input.publicPath,
    storageAdapterId: input.storageAdapterId,
    externallyHosted: input.externallyHosted,
  })
}

/**
 * Replace one variant entry inside `variants_json`. Reads the current
 * blob, mutates the matching entry (matched on the OLD `path` value so
 * we don't accidentally rewrite a variant that's already been migrated
 * in a concurrent run), writes it back.
 *
 * The variant entry is identified by `oldPath` because that's what we
 * captured pre-migration. If the row has been replaced or re-migrated
 * in the gap, the match fails and we leave the blob alone — the next
 * migration run picks the new shape up.
 */
export async function updateVariantStorageLocation(
  assetId: string,
  oldPath: string,
  next: {
    path: string
    storagePath: string
    storageAdapterId: string
    sizeBytes: number
  },
): Promise<boolean> {
  // The read-parse-mutate-write is ONE atomic Convex mutation (the SQL
  // transaction, docs/CONVEX-MIGRATION.md §3 #18). The variant entry is matched
  // on its OLD `path` so a concurrent re-migration isn't clobbered; a miss
  // leaves the blob untouched.
  return getConvex().mutation(api.media.updateVariantStorageLocation, {
    assetId,
    oldPath,
    path: next.path,
    storagePath: next.storagePath,
    storageAdapterId: next.storageAdapterId,
    sizeBytes: next.sizeBytes,
  })
}
