/**
 * Media folder repository.
 *
 * Convex port: the read/write bodies are now thin adapters over
 * `convex/mediaFolders.ts` (docs/CONVEX-MIGRATION.md §2). The pure `mapFolder`
 * hydrator stays here.
 *
 * Backs the HappyFiles-style folder tree on the Media page. Folders form a
 * tree via `parent_id` (null = root). Slugs are unique within a parent so
 * users can have two "Logos" folders under different roots — uniqueness is
 * re-expressed as an explicit index read in `convex/mediaFolders.ts` (§4.6).
 *
 * Asset membership is many-to-many through `media_asset_folders` — see
 * `repositories/media.ts → assignAssetToFolders` for that join.
 *
 * @see convex/mediaFolders.ts — the Convex query/mutation functions
 */
import { isoDate } from '@core/utils/isoDate'
import { api, getConvex } from '../convex/client'

interface MediaFolder {
  id: string
  parentId: string | null
  name: string
  slug: string
  sortOrder: number
  createdByUserId: string | null
  createdAt: string
}

interface CreateMediaFolderInput {
  id: string
  parentId: string | null
  name: string
  slug: string
  sortOrder?: number
  createdByUserId: string | null
}

export interface UpdateMediaFolderInput {
  name?: string
  slug?: string
  parentId?: string | null
  sortOrder?: number
}

interface MediaFolderRow {
  id: string
  parent_id: string | null
  name: string
  slug: string
  sort_order: number | string
  created_by_user_id: string | null
  created_at: Date | string
}

function mapFolder(row: MediaFolderRow): MediaFolder {
  return {
    id: row.id,
    parentId: row.parent_id ?? null,
    name: row.name,
    slug: row.slug,
    sortOrder: Number(row.sort_order),
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: isoDate(row.created_at),
  }
}

export async function listMediaFolders(): Promise<MediaFolder[]> {
  const rows = await getConvex().query(api.mediaFolders.list, {})
  return rows.map(mapFolder)
}

export async function getMediaFolder(
  id: string,
): Promise<MediaFolder | null> {
  const row = await getConvex().query(api.mediaFolders.get, { id })
  return row ? mapFolder(row) : null
}

export async function createMediaFolder(
  input: CreateMediaFolderInput,
): Promise<MediaFolder> {
  const row = await getConvex().mutation(api.mediaFolders.create, {
    id: input.id,
    parentId: input.parentId,
    name: input.name,
    slug: input.slug,
    sortOrder: input.sortOrder ?? 0,
    createdByUserId: input.createdByUserId,
  })
  return mapFolder(row)
}

export async function updateMediaFolder(
  id: string,
  input: UpdateMediaFolderInput,
): Promise<MediaFolder | null> {
  // `parentId` distinguishes "don't touch" (undefined → stripped from the wire
  // args → keep existing) from "move to root" (explicit null). `name`/`slug`/
  // `sortOrder` undefined likewise keep the existing column (COALESCE-keep).
  const row = await getConvex().mutation(api.mediaFolders.update, {
    id,
    name: input.name,
    slug: input.slug,
    sortOrder: input.sortOrder,
    parentId: input.parentId,
  })
  return row ? mapFolder(row) : null
}

/**
 * Delete a folder. The whole `parent_id` subtree and the asset-membership rows
 * of every deleted folder are removed (the SQL `ON DELETE CASCADE`, reproduced
 * explicitly in the Convex mutation) — the assets themselves stay (they just
 * become Uncategorized).
 */
export async function deleteMediaFolder(
  id: string,
): Promise<boolean> {
  return getConvex().mutation(api.mediaFolders.del, { id })
}

// ---------------------------------------------------------------------------
// Bundle export / import
// ---------------------------------------------------------------------------

/** A media folder serialized for bundle transfer (authorship dropped). */
export interface ExportableMediaFolder {
  id: string
  parentId: string | null
  name: string
  slug: string
  sortOrder: number
}

/** The whole folder tree, raw, for a full-site export. */
export async function listExportableMediaFolders(): Promise<ExportableMediaFolder[]> {
  const folders = await listMediaFolders()
  return folders.map((f) => ({
    id: f.id,
    parentId: f.parentId,
    name: f.name,
    slug: f.slug,
    sortOrder: f.sortOrder,
  }))
}

/** Wipe all folders (cascades membership) — used by the `replace` import strategy. */
export async function deleteAllMediaFolders(): Promise<void> {
  await getConvex().mutation(api.mediaFolders.deleteAll, {})
}

/**
 * Insert a folder preserving its original id, upserting on conflict so a
 * re-import is idempotent. `created_by_user_id` is left null — folder
 * authorship is instance-local and is not carried in the bundle. Used by the
 * bundle import handler.
 */
export async function importMediaFolder(
  input: ExportableMediaFolder,
): Promise<void> {
  await getConvex().mutation(api.mediaFolders.importFolder, {
    id: input.id,
    parentId: input.parentId,
    name: input.name,
    slug: input.slug,
    sortOrder: input.sortOrder,
  })
}

/**
 * Detect whether a (parent, slug) pair is already taken — used by the create
 * / rename handlers to return a friendly error rather than a raw unique
 * constraint violation.
 */
export async function isMediaFolderSlugTaken(
  parentId: string | null,
  slug: string,
  excludeId?: string,
): Promise<boolean> {
  return getConvex().query(api.mediaFolders.isSlugTaken, {
    parentId,
    slug,
    excludeId,
  })
}
