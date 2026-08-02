/**
 * Media widget reader — total asset count + bytes plus the latest 16
 * image thumbs with their variant ladder so the dashboard can build
 * srcset-aware thumbnails for the mosaic.
 */
import { listMediaAssets } from '../../../repositories/media'
import type { MediaStats } from './types'

const THUMB_LIMIT = 16

export async function readMediaStats(): Promise<MediaStats> {
  const assets = await listMediaAssets()
  const totalBytes = assets.reduce((sum, a) => sum + a.sizeBytes, 0)

  // Most-recent image-type assets. The dashboard widget renders them as a
  // thumbnail mosaic via the shared `<Image>` primitive, which builds a
  // srcset from the variant ladder.
  const latestThumbs = assets
    .filter((a) => a.mimeType.startsWith('image/'))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, THUMB_LIMIT)
    .map((a) => ({
      id: a.id,
      publicPath: a.publicPath,
      altText: a.altText,
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      variants: a.variants.map((v) => ({
        width: v.width,
        height: v.height,
        format: v.format,
        path: v.path,
      })),
    }))

  return {
    count: assets.length,
    totalBytes,
    latestThumbs,
  }
}
