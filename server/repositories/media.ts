/**
 * Media assets repository.
 *
 * Convex port: the read/write bodies are now thin adapters over `convex/media.ts`
 * (docs/CONVEX-MIGRATION.md §2).
 *
 * What stays here, on the Bun side:
 * - **`mapMediaAssetRow` / `parseVariants`** (from `./mediaAssetMapping`) — the
 *   single pure hydrators. Every Convex read returns the raw `media_assets`
 *   columns + the asset's resolved `folderIds`; `mapMediaAssetRow(row, folderIds)`
 *   turns that wire row into a `MediaAsset`, so the admin repository and the
 *   publisher's render-time prefetch share ONE asset shape and the `@core` date
 *   helpers never run inside Convex's V8 runtime.
 * - The asset domain types (`MediaAsset`, `MediaVariant`) re-exported below.
 *
 * The `assignAssetToFolders` transaction (§3 #17) collapses into the single
 * atomic `convex/media.ts` `assignAssetToFolders` mutation.
 *
 * @see convex/media.ts                 — the Convex query/mutation functions
 * @see server/repositories/mediaAssetMapping.ts — the pure row → asset mapper
 */
import { mapMediaAssetRow, parseVariants, type MediaAssetRow } from './mediaAssetMapping'
import type { MediaAsset, MediaVariant } from './mediaTypes'
import { api, getConvex } from '../convex/client'

// The row ↔ asset mapping unit (column constants, `MediaAssetRow`,
// `mapMediaAssetRow`, and the JSON parsers) lives in `./mediaAssetMapping` so it
// can be shared verbatim with the publisher's render-time prefetch without
// duplication. This module owns the asset domain types (`MediaAsset`,
// `MediaVariant`) and every CRUD query.

export type { MediaAsset, MediaVariant } from './mediaTypes'

interface CreateMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  uploadedByUserId: string | null
  /** Empty string = local-disk; otherwise the namespaced adapter id. */
  storageAdapterId: string
  /** True when this row's bytes are stored outside the host's uploads dir. */
  externallyHosted: boolean
}

export interface UpdateMediaAssetMetadataInput {
  filename?: string
  altText?: string
  caption?: string
  title?: string
  tags?: string[]
}

/** The wire row from `convex/media.ts`: a `MediaAssetRow` plus its `folderIds`. */
type ConvexMediaAssetRow = MediaAssetRow & { folderIds: string[] }

/** Hydrate a Convex wire row into a `MediaAsset` (folders come on the row). */
function toAsset(row: ConvexMediaAssetRow): MediaAsset {
  return mapMediaAssetRow(row, row.folderIds)
}

export async function createMediaAsset(
  input: CreateMediaAssetInput,
): Promise<MediaAsset> {
  const row = await getConvex().mutation(api.media.create, {
    id: input.id,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    storagePath: input.storagePath,
    publicPath: input.publicPath,
    uploadedByUserId: input.uploadedByUserId,
    storageAdapterId: input.storageAdapterId,
    externallyHosted: input.externallyHosted,
  })
  return toAsset(row)
}

export async function getMediaAsset(
  id: string,
): Promise<MediaAsset | null> {
  const row = await getConvex().query(api.media.get, { id })
  return row ? toAsset(row) : null
}

/**
 * List every media asset (active or in-trash, never both). The repo intentionally
 * returns the full set and lets the handler apply additional filters (folder /
 * type / search / tag / sort / pagination) in JS — the media library is small
 * enough (low thousands per site) that the round-trip dominates.
 */
export async function listMediaAssets(
  options: { includeDeleted?: boolean } = {},
): Promise<MediaAsset[]> {
  const rows = await getConvex().query(api.media.list, {
    includeDeleted: options.includeDeleted ?? false,
  })
  return rows.map(toAsset)
}

export async function renameMediaAsset(
  id: string,
  filename: string,
): Promise<MediaAsset | null> {
  const row = await getConvex().mutation(api.media.rename, { id, filename })
  return row ? toAsset(row) : null
}

/**
 * Patch user-editable metadata. Undefined inputs preserve the existing column
 * value (the Convex mutation applies `arg ?? existing`, the COALESCE-keep
 * semantics). Tags are canonicalised (lowercased, dedup, sorted) here before
 * the write so equality checks against a `{ tag }` filter behave predictably.
 */
export async function updateMediaAssetMetadata(
  id: string,
  input: UpdateMediaAssetMetadataInput,
): Promise<MediaAsset | null> {
  const tags = input.tags
    ? Array.from(new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort()
    : undefined

  const row = await getConvex().mutation(api.media.updateMetadata, {
    id,
    filename: input.filename,
    altText: input.altText,
    caption: input.caption,
    title: input.title,
    tags,
  })
  return row ? toAsset(row) : null
}

/**
 * Stamp the responsive-pipeline output (intrinsic dimensions + BlurHash +
 * variant index) onto a media row. Always overwrites — even with `null` —
 * because these columns are set exactly once per binary (or once per replace).
 */
export async function setMediaAssetVariants(
  id: string,
  input: {
    width: number | null
    height: number | null
    blurHash: string | null
    variants: MediaVariant[]
  },
): Promise<MediaAsset | null> {
  const row = await getConvex().mutation(api.media.setVariants, {
    id,
    width: input.width,
    height: input.height,
    blurHash: input.blurHash,
    variants: input.variants,
  })
  return row ? toAsset(row) : null
}

/**
 * Soft delete: stamp `deleted_at`. Restore un-stamps; `deleteMediaAsset`
 * finishes the job by removing the row (and caller removes the on-disk file).
 */
export async function softDeleteMediaAsset(
  id: string,
): Promise<MediaAsset | null> {
  const row = await getConvex().mutation(api.media.softDelete, { id })
  return row ? toAsset(row) : null
}

export async function restoreMediaAsset(
  id: string,
): Promise<MediaAsset | null> {
  const row = await getConvex().mutation(api.media.restore, { id })
  return row ? toAsset(row) : null
}

/**
 * Hard delete — removes the row. Caller is responsible for removing the
 * on-disk file using the returned `storagePath`.
 */
export async function deleteMediaAsset(
  id: string,
): Promise<{ storagePath: string } | null> {
  return getConvex().mutation(api.media.hardDelete, { id })
}

/**
 * Replace the binary backing this asset while keeping the same id so every
 * existing reference stays valid.
 *
 * `public_path` is no longer guaranteed stable — when the storage adapter
 * elected for the role differs from the one that wrote the previous
 * binary, the new bytes live on a different backend with a different
 * URL. Renderers reference media by asset id (or path) via the
 * `prefetchMediaAssets` lookup, which re-resolves on each publish, so a
 * URL change is transparent to consumers.
 */
export async function replaceMediaAssetBinary(
  id: string,
  input: {
    filename: string
    mimeType: string
    sizeBytes: number
    storagePath: string
    publicPath: string
    storageAdapterId: string
    externallyHosted: boolean
  },
): Promise<MediaAsset | null> {
  const row = await getConvex().mutation(api.media.replaceBinary, {
    id,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    storagePath: input.storagePath,
    publicPath: input.publicPath,
    storageAdapterId: input.storageAdapterId,
    externallyHosted: input.externallyHosted,
  })
  return row ? toAsset(row) : null
}

/**
 * Storage path of an existing asset without deleting it — used by the
 * replace-file handler to remove the previous binary after writing the new
 * one.
 */
export async function getMediaAssetStoragePath(
  id: string,
): Promise<string | null> {
  return getConvex().query(api.media.storagePath, { id })
}

/**
 * Pull just the responsive variants for an asset so the replace + purge
 * paths can sweep them off disk alongside the original. Returns an empty
 * array for assets that never had variants (non-image uploads, very small
 * images that didn't need a ladder).
 */
export async function getMediaAssetVariants(
  id: string,
): Promise<MediaVariant[]> {
  const variantsJson = await getConvex().query(api.media.variantsJson, { id })
  if (variantsJson === null) return []
  return parseVariants(variantsJson)
}

/**
 * Add and/or remove an asset's folder memberships in one transactional step
 * (the atomic `convex/media.ts` `assignAssetToFolders` mutation). Idempotent:
 * re-adding an existing membership is a no-op (a pre-write index read replaces
 * the SQL `ON CONFLICT DO NOTHING`).
 */
export async function assignAssetToFolders(
  assetId: string,
  input: { add?: string[]; remove?: string[] },
): Promise<MediaAsset | null> {
  const row = await getConvex().mutation(api.media.assignAssetToFolders, {
    assetId,
    add: input.add,
    remove: input.remove,
  })
  return row ? toAsset(row) : null
}

// ---------------------------------------------------------------------------
// Bundle export / import helpers
// ---------------------------------------------------------------------------

/** Count of non-deleted media assets available to export (no row hydration). */
export async function countMediaAssetsForExport(): Promise<number> {
  return getConvex().query(api.media.countForExport, {})
}

export async function listMediaAssetsForExport(): Promise<Array<MediaAsset & { storagePath: string }>> {
  const rows = await getConvex().query(api.media.listForExport, {})
  return rows.map((row) => ({
    ...mapMediaAssetRow(row, row.folderIds),
    storagePath: row.storage_path,
  }))
}

interface ImportMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  altText: string
  caption: string
  title: string
  tags: string[]
  width: number | null
  height: number | null
  durationMs: number | null
  dominantColor: string | null
  blurHash: string | null
  posterPath: string | null
  /** Optional; defaults to local-disk when omitted. */
  storageAdapterId?: string
  /** Optional; defaults to false when omitted. */
  externallyHosted?: boolean
}

/**
 * Insert a media asset record preserving its original id and metadata.
 * Used exclusively by the bundle import handler.
 *
 * Variants are intentionally omitted — they regenerate on first request.
 * Folder memberships are not imported (no folder rows to link to yet in
 * the target instance).
 *
 * If an asset with the same id already exists it is replaced.
 */
export async function importMediaAsset(
  input: ImportMediaAssetInput,
): Promise<void> {
  const tags = Array.from(new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))).sort()
  await getConvex().mutation(api.media.importAsset, {
    id: input.id,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    storagePath: input.storagePath,
    publicPath: input.publicPath,
    altText: input.altText,
    caption: input.caption,
    title: input.title,
    tags,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    dominantColor: input.dominantColor,
    blurHash: input.blurHash,
    posterPath: input.posterPath,
    storageAdapterId: input.storageAdapterId ?? '',
    externallyHosted: input.externallyHosted ?? false,
  })
}
