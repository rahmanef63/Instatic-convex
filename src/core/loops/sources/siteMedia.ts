/**
 * Built-in `site.media` loop source — iterates uploaded media assets.
 *
 * Reads from the `media_assets` table. Filters by mime-type prefix so a
 * loop can show "all images", "all videos", or unfiltered.
 *
 * Order options:
 *   - createdAt — upload time (newest/oldest first)
 *   - filename  — alphabetical
 */

import type { LoopEntitySource, LoopFetchResult, LoopItem } from '@core/loops/types'
import { getLoopDataAdapter, type MediaAssetRecord } from '@core/loops/dataAdapter'
import { isoDate } from '../../utils/isoDate'

function rowToLoopItem(row: MediaAssetRecord): LoopItem {
  return {
    id: row.id,
    fields: {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      path: row.public_path,
      url: row.public_path,
      src: row.public_path,
      uploadedByUserId: row.uploaded_by_user_id,
      uploadedById: row.uploaded_by_user_id,
      createdAt: isoDate(row.created_at),
    },
  }
}

export const SiteMediaSource: LoopEntitySource = {
  id: 'site.media',
  label: 'Media library',
  description: 'Loop uploaded media assets — filter by mime-type to scope to images or videos.',

  filterSchema: {
    mimePrefix: {
      type: 'select',
      label: 'Media type',
      options: [
        { label: 'All', value: '' },
        { label: 'Images', value: 'image/' },
        { label: 'Videos', value: 'video/' },
        { label: 'Audio', value: 'audio/' },
      ],
    },
  },

  orderByOptions: [
    { id: 'createdAt', label: 'Upload date' },
    { id: 'filename', label: 'Filename' },
  ],

  fields: [
    { id: 'filename', label: 'Filename' },
    { id: 'path', label: 'Path', format: 'url' },
    { id: 'url', label: 'URL', format: 'url' },
    { id: 'src', label: 'Source URL', format: 'media' },
    { id: 'mimeType', label: 'MIME type' },
    { id: 'createdAt', label: 'Upload date' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    const mimePrefix =
      typeof ctx.filters.mimePrefix === 'string' ? ctx.filters.mimePrefix : ''
    const orderBy: 'createdAt' | 'filename' =
      ctx.orderBy === 'filename' ? 'filename' : 'createdAt'
    const direction: 'asc' | 'desc' = ctx.direction === 'asc' ? 'asc' : 'desc'

    const { rows, total } = await getLoopDataAdapter().mediaItems({
      mimePrefix,
      orderBy,
      direction,
      limit: ctx.limit,
      offset: ctx.offset,
    })
    return {
      items: rows.map(rowToLoopItem),
      totalItems: total,
    }
  },

  preview() {
    // Editor-side preview is handled by the canvas via `useLoopPreviewItems`,
    // which fetches real media assets through the CMS API. This source's
    // synchronous `preview()` therefore returns [] — no placeholder
    // thumbnails leak into the canvas.
    return []
  },
}
