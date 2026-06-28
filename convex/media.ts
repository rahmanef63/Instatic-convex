/**
 * Media assets — Convex functions.
 *
 * The Convex half of the `media_assets` domain (plus its `media_asset_folders`
 * membership join, the storage-migration helpers, and the
 * `published_runtime_assets` runtime-asset store). The thin repository adapters
 * (`server/repositories/{media,mediaMigration,runtimeAsset}.ts`) marshal args
 * into these and map the results back into the frozen `MediaAsset` /
 * `MediaVariant` shapes (docs/CONVEX-MIGRATION.md §2). The split mirrors the
 * proven `users` / `dataRows` slices:
 *
 * - **Hydration stays in the repository.** Every asset read here returns the
 *   raw `media_assets` columns plus the asset's `folderIds` (batch-resolved from
 *   `media_asset_folders` by the `by_asset` index — the Convex equivalent of the
 *   repository's `loadFolderIdsForAssets`, no N+1). The repository's pure
 *   `mapMediaAssetRow` / `parseVariants` (`./mediaAssetMapping`) then turn that
 *   wire row into a `MediaAsset`. This keeps ONE hydration path and keeps the
 *   `@core` date helpers out of the Convex V8 runtime.
 * - **`tags_json` / `variants_json` are opaque JSON strings at rest** (§6); they
 *   travel verbatim and are parsed by `mapMediaAssetRow` / `parseVariants` in
 *   the repository (which already accept either a string or a parsed array).
 * - **`content_bytes` is true binary** (`v.bytes()` per the schema, matching
 *   `convex/dataPublish.ts`'s `persistSitePublish`); it crosses the wire as an
 *   `ArrayBuffer`.
 *
 * Convex has no `ON CONFLICT` (§4.6 → read-by-index → patch-or-insert), no
 * unique index (the `public_path` uniqueness is not re-enforced here — the SQL
 * relied on it only to reject a duplicate, which the upload pipeline already
 * prevents), and no cascade delete (§ → children deleted explicitly):
 * `deleteMediaAsset` removes the asset's `media_asset_folders` + `media_usage_refs`
 * rows by hand (the SQL `ON DELETE CASCADE`).
 *
 * Transactions collapsed to single atomic mutations (docs/CONVEX-MIGRATION.md
 * §3): `assignAssetToFolders` (#17 — delete old memberships + upsert new +
 * re-read) and `updateVariantStorageLocation` (#18 — read variants JSON, mutate
 * one entry, write back).
 *
 * App identity is the asset's nanoid `id` (generated Bun-side, passed in);
 * `created_at` replaces the SQL `current_timestamp` default and is stamped here.
 * Convex `_id` never leaks out. Every function declares both `args` AND
 * `returns` validators.
 *
 * @see server/repositories/media.ts          — asset CRUD adapter
 * @see server/repositories/mediaMigration.ts — storage-migration adapter
 * @see server/repositories/runtimeAsset.ts   — runtime-asset adapter
 * @see server/repositories/mediaAssetMapping.ts — the pure row → asset mapper
 */

import { v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

// ---------------------------------------------------------------------------
// Wire validators (the repository's `MediaAssetRow` + its hydrated folderIds)
// ---------------------------------------------------------------------------

/**
 * The raw `media_assets` projection the repository's `mapMediaAssetRow`
 * consumes, plus the asset's resolved `folderIds`. `alt_text` / `caption` /
 * `title` are non-null in the schema so they return `v.string()`; the mapper
 * tolerates either. `tags_json` / `variants_json` are the opaque JSON strings
 * (the mapper parses them). `storage_path` is deliberately absent — the public
 * read paths never expose it (the export query adds it explicitly).
 */
const mediaAssetRowFields = {
  id: v.string(),
  filename: v.string(),
  mime_type: v.string(),
  size_bytes: v.number(),
  public_path: v.string(),
  uploaded_by_user_id: v.union(v.null(), v.string()),
  created_at: v.string(),
  alt_text: v.string(),
  caption: v.string(),
  title: v.string(),
  tags_json: v.string(),
  width: v.union(v.null(), v.number()),
  height: v.union(v.null(), v.number()),
  duration_ms: v.union(v.null(), v.number()),
  dominant_color: v.union(v.null(), v.string()),
  deleted_at: v.union(v.null(), v.string()),
  replaced_at: v.union(v.null(), v.string()),
  blur_hash: v.union(v.null(), v.string()),
  variants_json: v.string(),
  poster_path: v.union(v.null(), v.string()),
  storage_adapter_id: v.string(),
  externally_hosted: v.boolean(),
  folderIds: v.array(v.string()),
}

const mediaAssetRowValidator = v.object(mediaAssetRowFields)
const mediaAssetExportRowValidator = v.object({
  ...mediaAssetRowFields,
  storage_path: v.string(),
})

// ---------------------------------------------------------------------------
// Lookup + hydration helpers
// ---------------------------------------------------------------------------

function assetByAppId(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db
    .query('media_assets')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

/** Resolve one asset's folder ids (the repository's per-asset folder join). */
async function folderIdsForAsset(
  ctx: QueryCtx | MutationCtx,
  assetId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query('media_asset_folders')
    .withIndex('by_asset', (q) => q.eq('asset_id', assetId))
    .collect()
  return rows.map((r) => r.folder_id)
}

/** Project a `media_assets` doc into the wire row + its resolved folder ids. */
function toRow(doc: Doc<'media_assets'>, folderIds: string[]) {
  return {
    id: doc.id,
    filename: doc.filename,
    mime_type: doc.mime_type,
    size_bytes: doc.size_bytes,
    public_path: doc.public_path,
    uploaded_by_user_id: doc.uploaded_by_user_id,
    created_at: doc.created_at,
    alt_text: doc.alt_text,
    caption: doc.caption,
    title: doc.title,
    tags_json: doc.tags_json,
    width: doc.width,
    height: doc.height,
    duration_ms: doc.duration_ms,
    dominant_color: doc.dominant_color,
    deleted_at: doc.deleted_at,
    replaced_at: doc.replaced_at,
    blur_hash: doc.blur_hash,
    variants_json: doc.variants_json,
    poster_path: doc.poster_path,
    storage_adapter_id: doc.storage_adapter_id,
    externally_hosted: doc.externally_hosted,
    folderIds,
  }
}

/** Hydrate a single doc (one folder-membership read). */
async function hydrate(ctx: QueryCtx | MutationCtx, doc: Doc<'media_assets'>) {
  return toRow(doc, await folderIdsForAsset(ctx, doc.id))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Hydrate a single asset by app id (no soft-delete filter — mirrors `getMediaAsset`). */
export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, { id }) => {
    const doc = await assetByAppId(ctx, id)
    if (!doc) return null
    return hydrate(ctx, doc)
  },
})

/**
 * Every asset for the library: either the active set (`deleted_at is null`,
 * newest-created first) or the trash (`deleted_at is not null`, newest-deleted
 * first). The handler applies the remaining filters in JS.
 */
export const list = query({
  args: { includeDeleted: v.optional(v.boolean()) },
  returns: v.array(mediaAssetRowValidator),
  handler: async (ctx, { includeDeleted }) => {
    const all = await ctx.db.query('media_assets').collect()
    const selected = includeDeleted
      ? all
          .filter((r) => r.deleted_at !== null)
          .sort((a, b) =>
            (a.deleted_at as string) < (b.deleted_at as string)
              ? 1
              : (a.deleted_at as string) > (b.deleted_at as string)
                ? -1
                : 0,
          )
      : all
          .filter((r) => r.deleted_at === null)
          .sort((a, b) =>
            a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
          )
    const out = []
    for (const doc of selected) out.push(await hydrate(ctx, doc))
    return out
  },
})

/** Storage path of an asset (no delete) — used by the replace-file handler. */
export const storagePath = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { id }) => {
    const doc = await assetByAppId(ctx, id)
    return doc ? doc.storage_path : null
  },
})

/** Raw `variants_json` for an asset (the repository parses it). `null` = no row. */
export const variantsJson = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { id }) => {
    const doc = await assetByAppId(ctx, id)
    return doc ? doc.variants_json : null
  },
})

/** Count of non-deleted assets available for bundle export. */
export const countForExport = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const all = await ctx.db.query('media_assets').collect()
    return all.filter((r) => r.deleted_at === null).length
  },
})

/** Every non-deleted asset incl. its storage_path, oldest first — for export. */
export const listForExport = query({
  args: {},
  returns: v.array(mediaAssetExportRowValidator),
  handler: async (ctx) => {
    const all = await ctx.db.query('media_assets').collect()
    const live = all
      .filter((r) => r.deleted_at === null)
      .sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      )
    const out = []
    for (const doc of live) {
      out.push({ ...(await hydrate(ctx, doc)), storage_path: doc.storage_path })
    }
    return out
  },
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a new asset. Mirrors the SQL INSERT: the caller supplies the upload
 * columns; the rest take the SQL column defaults (alt/caption/title `''`,
 * tags/variants `'[]'`, dimensions/color/poster null). `created_at` is stamped
 * here. Returns the (folder-less) hydrated row.
 */
export const create = mutation({
  args: {
    id: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storagePath: v.string(),
    publicPath: v.string(),
    uploadedByUserId: v.union(v.null(), v.string()),
    storageAdapterId: v.string(),
    externallyHosted: v.boolean(),
  },
  returns: mediaAssetRowValidator,
  handler: async (ctx, args) => {
    const now = new Date().toISOString()
    const docId = await ctx.db.insert('media_assets', {
      id: args.id,
      filename: args.filename,
      mime_type: args.mimeType,
      size_bytes: args.sizeBytes,
      storage_path: args.storagePath,
      public_path: args.publicPath,
      uploaded_by_user_id: args.uploadedByUserId,
      alt_text: '',
      caption: '',
      title: '',
      tags_json: '[]',
      width: null,
      height: null,
      duration_ms: null,
      dominant_color: null,
      blur_hash: null,
      variants_json: '[]',
      poster_path: null,
      deleted_at: null,
      replaced_at: null,
      created_at: now,
      storage_adapter_id: args.storageAdapterId,
      externally_hosted: args.externallyHosted,
    })
    const fresh = await ctx.db.get(docId)
    return toRow(fresh!, [])
  },
})

/** Rename an asset; returns the hydrated row, or `null` if missing. */
export const rename = mutation({
  args: { id: v.string(), filename: v.string() },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, { id, filename }) => {
    const doc = await assetByAppId(ctx, id)
    if (!doc) return null
    await ctx.db.patch(doc._id, { filename })
    const fresh = await ctx.db.get(doc._id)
    return hydrate(ctx, fresh!)
  },
})

/**
 * Patch user-editable metadata. Mirrors the SQL `COALESCE(?, col)`:
 * `undefined`/absent args keep the existing value (the repository pre-applies
 * the tag canonicalisation and passes the resolved array or omits it).
 */
export const updateMetadata = mutation({
  args: {
    id: v.string(),
    filename: v.optional(v.string()),
    altText: v.optional(v.string()),
    caption: v.optional(v.string()),
    title: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, args) => {
    const doc = await assetByAppId(ctx, args.id)
    if (!doc) return null
    await ctx.db.patch(doc._id, {
      filename: args.filename ?? doc.filename,
      alt_text: args.altText ?? doc.alt_text,
      caption: args.caption ?? doc.caption,
      title: args.title ?? doc.title,
      tags_json: args.tags === undefined ? doc.tags_json : JSON.stringify(args.tags),
    })
    const fresh = await ctx.db.get(doc._id)
    return hydrate(ctx, fresh!)
  },
})

/**
 * Stamp the responsive-pipeline output. Always overwrites (even with `null`) —
 * unlike `updateMetadata` these columns are set once per binary.
 */
export const setVariants = mutation({
  args: {
    id: v.string(),
    width: v.union(v.null(), v.number()),
    height: v.union(v.null(), v.number()),
    blurHash: v.union(v.null(), v.string()),
    variants: v.array(v.any()),
  },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, args) => {
    const doc = await assetByAppId(ctx, args.id)
    if (!doc) return null
    await ctx.db.patch(doc._id, {
      width: args.width,
      height: args.height,
      blur_hash: args.blurHash,
      variants_json: JSON.stringify(args.variants),
    })
    const fresh = await ctx.db.get(doc._id)
    return hydrate(ctx, fresh!)
  },
})

/**
 * Soft-delete: stamp `deleted_at` only when currently live. When the row is
 * already trashed (or never had `deleted_at` cleared) it is still returned
 * hydrated — matching the SQL fall-through to `getMediaAsset(db, id)`.
 */
export const softDelete = mutation({
  args: { id: v.string() },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, { id }) => {
    const doc = await assetByAppId(ctx, id)
    if (!doc) return null
    if (doc.deleted_at === null) {
      await ctx.db.patch(doc._id, { deleted_at: new Date().toISOString() })
      const fresh = await ctx.db.get(doc._id)
      return hydrate(ctx, fresh!)
    }
    return hydrate(ctx, doc)
  },
})

/** Restore a trashed asset (un-stamp `deleted_at`); `null` if missing. */
export const restore = mutation({
  args: { id: v.string() },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, { id }) => {
    const doc = await assetByAppId(ctx, id)
    if (!doc) return null
    await ctx.db.patch(doc._id, { deleted_at: null })
    const fresh = await ctx.db.get(doc._id)
    return hydrate(ctx, fresh!)
  },
})

/**
 * Hard-delete the row, returning its `storage_path` so the caller can sweep the
 * bytes. Convex has no cascade, so the asset's `media_asset_folders` membership
 * + `media_usage_refs` rows (SQL `ON DELETE CASCADE`) are deleted explicitly.
 */
export const hardDelete = mutation({
  args: { id: v.string() },
  returns: v.union(v.null(), v.object({ storagePath: v.string() })),
  handler: async (ctx, { id }) => {
    const doc = await assetByAppId(ctx, id)
    if (!doc) return null
    const memberships = await ctx.db
      .query('media_asset_folders')
      .withIndex('by_asset', (q) => q.eq('asset_id', id))
      .collect()
    for (const m of memberships) await ctx.db.delete(m._id)
    const usageRefs = await ctx.db
      .query('media_usage_refs')
      .withIndex('by_asset', (q) => q.eq('asset_id', id))
      .collect()
    for (const u of usageRefs) await ctx.db.delete(u._id)
    const storage = doc.storage_path
    await ctx.db.delete(doc._id)
    return { storagePath: storage }
  },
})

/**
 * Replace the binary backing an asset (keeps the id). Overwrites the storage
 * columns + stamps `replaced_at`. Returns the hydrated row, or `null`.
 */
export const replaceBinary = mutation({
  args: {
    id: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storagePath: v.string(),
    publicPath: v.string(),
    storageAdapterId: v.string(),
    externallyHosted: v.boolean(),
  },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, args) => {
    const doc = await assetByAppId(ctx, args.id)
    if (!doc) return null
    await ctx.db.patch(doc._id, {
      filename: args.filename,
      mime_type: args.mimeType,
      size_bytes: args.sizeBytes,
      storage_path: args.storagePath,
      public_path: args.publicPath,
      storage_adapter_id: args.storageAdapterId,
      externally_hosted: args.externallyHosted,
      replaced_at: new Date().toISOString(),
    })
    const fresh = await ctx.db.get(doc._id)
    return hydrate(ctx, fresh!)
  },
})

/**
 * Add and/or remove an asset's folder memberships in ONE atomic mutation
 * (docs/CONVEX-MIGRATION.md §3 #17). Convex has no `ON CONFLICT DO NOTHING`, so
 * an add is idempotent via a pre-write read of the `by_asset_folder` index.
 * Returns the re-read hydrated asset, or `null` when the asset is missing.
 */
export const assignAssetToFolders = mutation({
  args: {
    assetId: v.string(),
    add: v.optional(v.array(v.string())),
    remove: v.optional(v.array(v.string())),
  },
  returns: v.union(v.null(), mediaAssetRowValidator),
  handler: async (ctx, { assetId, add, remove }) => {
    for (const folderId of remove ?? []) {
      const existing = await ctx.db
        .query('media_asset_folders')
        .withIndex('by_asset_folder', (q) =>
          q.eq('asset_id', assetId).eq('folder_id', folderId),
        )
        .unique()
      if (existing) await ctx.db.delete(existing._id)
    }
    for (const folderId of add ?? []) {
      const existing = await ctx.db
        .query('media_asset_folders')
        .withIndex('by_asset_folder', (q) =>
          q.eq('asset_id', assetId).eq('folder_id', folderId),
        )
        .unique()
      if (!existing) {
        await ctx.db.insert('media_asset_folders', { asset_id: assetId, folder_id: folderId })
      }
    }
    const doc = await assetByAppId(ctx, assetId)
    if (!doc) return null
    return hydrate(ctx, doc)
  },
})

/**
 * Id-preserving asset upsert for bundle import (§4.6 read-by-index →
 * patch-or-insert). Variants are intentionally NOT imported (they regenerate);
 * the row's `variants_json` keeps its default `'[]'` on insert and is left
 * untouched on update.
 */
export const importAsset = mutation({
  args: {
    id: v.string(),
    filename: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storagePath: v.string(),
    publicPath: v.string(),
    altText: v.string(),
    caption: v.string(),
    title: v.string(),
    tags: v.array(v.string()),
    width: v.union(v.null(), v.number()),
    height: v.union(v.null(), v.number()),
    durationMs: v.union(v.null(), v.number()),
    dominantColor: v.union(v.null(), v.string()),
    blurHash: v.union(v.null(), v.string()),
    posterPath: v.union(v.null(), v.string()),
    storageAdapterId: v.string(),
    externallyHosted: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const tagsJson = JSON.stringify(args.tags)
    const shared = {
      filename: args.filename,
      mime_type: args.mimeType,
      size_bytes: args.sizeBytes,
      storage_path: args.storagePath,
      public_path: args.publicPath,
      alt_text: args.altText,
      caption: args.caption,
      title: args.title,
      tags_json: tagsJson,
      width: args.width,
      height: args.height,
      duration_ms: args.durationMs,
      dominant_color: args.dominantColor,
      blur_hash: args.blurHash,
      poster_path: args.posterPath,
      storage_adapter_id: args.storageAdapterId,
      externally_hosted: args.externallyHosted,
    }
    const existing = await assetByAppId(ctx, args.id)
    if (existing) {
      await ctx.db.patch(existing._id, shared)
    } else {
      await ctx.db.insert('media_assets', {
        id: args.id,
        ...shared,
        uploaded_by_user_id: null,
        variants_json: '[]',
        deleted_at: null,
        replaced_at: null,
        created_at: new Date().toISOString(),
      })
    }
    return null
  },
})

// ---------------------------------------------------------------------------
// Storage migration (server/repositories/mediaMigration.ts)
// ---------------------------------------------------------------------------

/**
 * Backlog inputs for the storage-migration badge: the count of originals on a
 * non-target adapter, plus every non-deleted row's `variants_json` (only the
 * non-empty ones) so the repository can count pending VARIANT entries with its
 * own pure parser — exactly the data the SQL `select variants_json …` pulled
 * JS-side (no per-variant DB row exists).
 */
export const migrationBacklogData = query({
  args: { originalTarget: v.string() },
  returns: v.object({ originals: v.number(), variantsJsons: v.array(v.string()) }),
  handler: async (ctx, { originalTarget }) => {
    const all = await ctx.db.query('media_assets').collect()
    const live = all.filter((r) => r.deleted_at === null)
    const originals = live.filter((r) => r.storage_adapter_id !== originalTarget).length
    const variantsJsons = live
      .map((r) => r.variants_json)
      .filter((j) => j !== '' && j !== '[]')
    return { originals, variantsJsons }
  },
})

/**
 * One page of originals on a non-target adapter, ordered by app id ascending
 * (`id > cursor`), exactly the SQL cursor scan. Returns up to `limit` rows; the
 * repository derives `nextCursor`.
 */
export const listPendingOriginals = query({
  args: {
    targetAdapterId: v.string(),
    cursor: v.union(v.null(), v.string()),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      id: v.string(),
      filename: v.string(),
      mime_type: v.string(),
      size_bytes: v.number(),
      storage_path: v.string(),
      public_path: v.string(),
      storage_adapter_id: v.string(),
    }),
  ),
  handler: async (ctx, { targetAdapterId, cursor, limit }) => {
    const scan = await ctx.db
      .query('media_assets')
      .withIndex('by_app_id', (q) => (cursor === null ? q : q.gt('id', cursor)))
      .order('asc')
      .collect()
    const out = []
    for (const r of scan) {
      if (r.deleted_at !== null || r.storage_adapter_id === targetAdapterId) continue
      out.push({
        id: r.id,
        filename: r.filename,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        storage_path: r.storage_path,
        public_path: r.public_path,
        storage_adapter_id: r.storage_adapter_id,
      })
      if (out.length === limit) break
    }
    return out
  },
})

/**
 * One page of non-deleted rows that HAVE a `variants_json`, ordered by app id
 * ascending (`id > cursor`). Returns up to `limit` raw rows (the SQL row scan) —
 * the repository parses each blob, keeps only rows with a pending variant, and
 * advances `nextCursor` on the SCAN (never on the kept items, or an all-migrated
 * batch would loop forever).
 */
export const listAssetsWithPendingVariants = query({
  args: { cursor: v.union(v.null(), v.string()), limit: v.number() },
  returns: v.array(
    v.object({ id: v.string(), storage_path: v.string(), variants_json: v.string() }),
  ),
  handler: async (ctx, { cursor, limit }) => {
    const scan = await ctx.db
      .query('media_assets')
      .withIndex('by_app_id', (q) => (cursor === null ? q : q.gt('id', cursor)))
      .order('asc')
      .collect()
    const out = []
    for (const r of scan) {
      if (r.deleted_at !== null || r.variants_json === '' || r.variants_json === '[]') continue
      out.push({ id: r.id, storage_path: r.storage_path, variants_json: r.variants_json })
      if (out.length === limit) break
    }
    return out
  },
})

/** Overwrite an asset's storage-location columns after a destination upload. */
export const updateAssetStorageLocation = mutation({
  args: {
    id: v.string(),
    storagePath: v.string(),
    publicPath: v.string(),
    storageAdapterId: v.string(),
    externallyHosted: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await assetByAppId(ctx, args.id)
    if (doc) {
      await ctx.db.patch(doc._id, {
        storage_path: args.storagePath,
        public_path: args.publicPath,
        storage_adapter_id: args.storageAdapterId,
        externally_hosted: args.externallyHosted,
      })
    }
    return null
  },
})

/**
 * Mirror of the repository's `parseVariantsFromJson` — re-declared inline
 * because `updateVariantStorageLocation` must read-modify-write `variants_json`
 * inside ONE atomic mutation (docs/CONVEX-MIGRATION.md §3 #18), and a server
 * module can't be imported into the Convex bundle. Normalises every entry
 * (deriving `storagePath`/`storageAdapterId` for legacy rows, dropping malformed
 * entries) so the rewritten blob matches what the SQL path wrote back.
 */
interface InlineVariant {
  width: number
  height: number
  format: 'webp' | 'jpeg' | 'png' | 'avif'
  path: string
  sizeBytes: number
  storagePath: string
  storageAdapterId: string
}

function parseVariantsInline(raw: string): InlineVariant[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: InlineVariant[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.width !== 'number' || typeof e.height !== 'number') continue
    if (typeof e.path !== 'string' || typeof e.sizeBytes !== 'number') continue
    if (e.format !== 'webp' && e.format !== 'jpeg' && e.format !== 'png' && e.format !== 'avif') {
      continue
    }
    const storagePath =
      typeof e.storagePath === 'string' && e.storagePath
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

/**
 * Replace one variant entry inside an asset's `variants_json` in ONE atomic
 * mutation (docs/CONVEX-MIGRATION.md §3 #18): read the blob, match the entry by
 * its OLD `path` (so a concurrent re-migration isn't clobbered), rewrite its
 * location fields, write the normalised array back. Returns `false` (no patch)
 * when the row is gone or no entry matched.
 */
export const updateVariantStorageLocation = mutation({
  args: {
    assetId: v.string(),
    oldPath: v.string(),
    path: v.string(),
    storagePath: v.string(),
    storageAdapterId: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const doc = await assetByAppId(ctx, args.assetId)
    if (!doc) return false
    const variants = parseVariantsInline(doc.variants_json)
    let updated = false
    const rewritten = variants.map((variant) => {
      if (variant.path !== args.oldPath) return variant
      updated = true
      return {
        ...variant,
        path: args.path,
        storagePath: args.storagePath,
        storageAdapterId: args.storageAdapterId,
        sizeBytes: args.sizeBytes,
      }
    })
    if (!updated) return false
    await ctx.db.patch(doc._id, { variants_json: JSON.stringify(rewritten) })
    return true
  },
})

// ---------------------------------------------------------------------------
// Published runtime assets (server/repositories/runtimeAsset.ts)
// ---------------------------------------------------------------------------

/**
 * Persist the per-publish runtime-asset files for a data-row version. `id` is
 * generated Bun-side (passed in); `content_bytes` crosses as true binary
 * (`v.bytes()`), matching `convex/dataPublish.ts`'s `persistSitePublish`.
 */
export const saveRuntimeAssets = mutation({
  args: {
    dataRowVersionId: v.string(),
    files: v.array(
      v.object({
        id: v.string(),
        assetPath: v.string(),
        publicPath: v.string(),
        contentType: v.string(),
        bytes: v.bytes(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { dataRowVersionId, files }) => {
    const now = new Date().toISOString()
    for (const file of files) {
      await ctx.db.insert('published_runtime_assets', {
        id: file.id,
        data_row_version_id: dataRowVersionId,
        asset_path: file.assetPath,
        public_path: file.publicPath,
        content_type: file.contentType,
        content_bytes: file.bytes,
        created_at: now,
      })
    }
    return null
  },
})

/** Fetch one published runtime asset by its public path. */
export const getRuntimeAsset = query({
  args: { publicPath: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      public_path: v.string(),
      content_type: v.string(),
      content_bytes: v.bytes(),
    }),
  ),
  handler: async (ctx, { publicPath }) => {
    const doc = await ctx.db
      .query('published_runtime_assets')
      .withIndex('by_public_path', (q) => q.eq('public_path', publicPath))
      .first()
    if (!doc) return null
    return {
      public_path: doc.public_path,
      content_type: doc.content_type,
      content_bytes: doc.content_bytes,
    }
  },
})
