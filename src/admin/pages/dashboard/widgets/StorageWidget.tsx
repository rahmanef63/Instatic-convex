/**
 * Storage widget — total used + a StackedBar showing the per-category
 * breakdown.
 *
 * There is intentionally **no quota** here. Self-hosted Instatic
 * never imposes an artificial disk cap, so the headline stat is the
 * total currently in use and the breakdown bar stretches to fill its
 * full width — each segment reads as a proportion of *what is used*,
 * not of an imaginary plan limit.
 *
 * Data comes from `useStorageStats()` → `/admin/api/cms/dashboard/storage`.
 * Sizing detail per segment:
 *   • Images     — sum of media asset sizes for `image/*`.
 *   • Videos     — sum of media asset sizes for `video/*`.
 *   • Documents  — sum of media asset sizes for everything else
 *                  (audio, PDFs, archives, unknown mime types).
 *   • Plugins    — total bytes under `<uploadsDir>/plugins/` on disk.
 */
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { StackedBar, StatValue } from '@ui/components/charts'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import { useStorageStats } from '../hooks/useDashboardStats'

/**
 * Human-readable byte formatter — drops decimals for B/KB/MB and keeps
 * one significant decimal for GB/TB so values like "1.4 GB" read
 * naturally. Matches the formatter in `MediaWidget.tsx` so users see
 * the same units across both tiles.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function StorageWidget({ span, editing }: DashboardWidgetRendererProps) {
  const stats = useStorageStats()
  return (
    <Widget
      widgetId="storage"
      title="Storage"
      icon={DatabaseSolidIcon}
      tint="sky"
      span={span}
      editing={editing}
      loading={stats === null}
    >
      {stats && (
        <>
          <StatValue
            value={formatSize(stats.totalBytes)}
            sub={<span>used · self-hosted</span>}
          />
          {/* The breakdown bar is given `total = totalBytes` so the
              segments stretch to fill the entire width — with no quota
              there is no empty "remaining" tail. When totalBytes is 0
              (fresh install, no media, no plugins, near-empty DB) we
              fall back to `1` to avoid `NaN%` widths; every segment
              value is also 0 in that case, so the bar simply renders
              the empty-track background and the legend reads "0 B"
              across the board. */}
          <StackedBar
            segments={[
              {
                label: 'Images',
                value: stats.imageBytes,
                color: 'var(--accent-4)',
              },
              {
                label: 'Videos',
                value: stats.videoBytes,
                color: 'var(--accent-2)',
              },
              {
                label: 'Documents',
                value: stats.documentBytes,
                color: 'var(--accent-5)',
              },
              {
                label: 'Plugins',
                value: stats.pluginBytes,
                color: 'var(--accent-1)',
              },
            ]}
            total={stats.totalBytes > 0 ? stats.totalBytes : 1}
            formatValue={(value) => formatSize(value)}
          />
        </>
      )}
    </Widget>
  )
}
