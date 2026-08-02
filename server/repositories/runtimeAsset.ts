/**
 * Published runtime-asset repository.
 *
 * Convex port: the read/write bodies are now thin adapters over `convex/media.ts`
 * (`saveRuntimeAssets` / `getRuntimeAsset`, docs/CONVEX-MIGRATION.md §2).
 *
 * `published_runtime_assets.content_bytes` is true binary (`v.bytes()` per the
 * schema, §6): the Bun side passes a tightly-packed `ArrayBuffer` on write and
 * decodes the returned `ArrayBuffer` back to a `Uint8Array` on read. The nanoid
 * id (the SQL `${nanoid()}` default) is generated here.
 *
 * @see convex/media.ts — `saveRuntimeAssets` / `getRuntimeAsset`
 */
import { nanoid } from 'nanoid'
import type { BuiltRuntimeAssetFile } from '../publish/runtime/bundleScripts'
import { api, getConvex } from '../convex/client'

interface PublishedRuntimeAssetRecord {
  publicPath: string
  contentType: string
  bytes: Uint8Array
}

/** Copy a `Uint8Array` into a fresh tightly-packed `ArrayBuffer` for `v.bytes()`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

export async function savePublishedRuntimeAssets(
  dataRowVersionId: string,
  files: BuiltRuntimeAssetFile[],
): Promise<void> {
  await getConvex().mutation(api.media.saveRuntimeAssets, {
    dataRowVersionId,
    files: files.map((file) => ({
      id: nanoid(),
      assetPath: file.path,
      publicPath: file.publicPath,
      contentType: file.contentType,
      bytes: toArrayBuffer(file.bytes),
    })),
  })
}

export async function getPublishedRuntimeAsset(
  publicPath: string,
): Promise<PublishedRuntimeAssetRecord | null> {
  const row = await getConvex().query(api.media.getRuntimeAsset, { publicPath })
  if (!row) return null
  return {
    publicPath: row.public_path,
    contentType: row.content_type,
    bytes: new Uint8Array(row.content_bytes),
  }
}
