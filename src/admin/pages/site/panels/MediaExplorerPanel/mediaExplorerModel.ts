// Shared media-explorer vocabulary: the bucket/filter/view-mode types and the
// human-facing bucket labels. Kept free of React and DOM so both the panel
// container and its sub-components can import from one place.

export type MediaBucket = 'images' | 'videos' | 'other'
export type MediaFilter = 'all' | MediaBucket
export type MediaViewMode = 'list' | 'grid'

export const BUCKET_LABELS: Record<MediaBucket, string> = {
  images: 'Images',
  videos: 'Videos',
  other: 'Other',
}
