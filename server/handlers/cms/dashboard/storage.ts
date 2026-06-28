/**
 * Storage widget reader — per-category byte counts (image / video /
 * document media + plugins-on-disk).
 *
 * Media is split into three sub-categories by `mimeType` prefix. Anything
 * that isn't `image/*` or `video/*` (audio, application/*, text/*, fonts)
 * lands in `documentBytes` so the three counters are guaranteed to sum
 * back to the total media bytes.
 *
 * Under Convex there is no host-stat-able database file, so the widget no
 * longer reports a database-size segment.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listMediaAssets } from '../../../repositories/media'
import type { CmsHandlerOptions } from '../shared'
import type { StorageStats } from './types'

export async function readStorageStats(
  options: CmsHandlerOptions,
): Promise<StorageStats> {
  const [assets, pluginBytes] = await Promise.all([
    listMediaAssets(),
    options.uploadsDir
      ? sumDirectoryBytes(join(options.uploadsDir, 'plugins'))
      : Promise.resolve(0),
  ])

  let imageBytes = 0
  let videoBytes = 0
  let documentBytes = 0
  for (const a of assets) {
    if (a.mimeType.startsWith('image/')) imageBytes += a.sizeBytes
    else if (a.mimeType.startsWith('video/')) videoBytes += a.sizeBytes
    else documentBytes += a.sizeBytes
  }

  return {
    imageBytes,
    videoBytes,
    documentBytes,
    pluginBytes,
    totalBytes: imageBytes + videoBytes + documentBytes + pluginBytes,
  }
}

/**
 * Recursively sum the byte sizes of every regular file under `dir`.
 *
 * Returns `0` when the directory does not exist (e.g. a fresh install
 * with no plugins installed yet). Symlinks are resolved via the default
 * `stat` behaviour — that's fine for the plugin asset tree which is
 * always a regular directory tree the server writes itself. Any per-
 * entry error (a file vanishing between `readdir` and `stat`, a
 * permission gap) is swallowed for that entry and counted as zero; the
 * dashboard widget is a usage estimate, not a forensic audit.
 */
async function sumDirectoryBytes(dir: string): Promise<number> {
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[]
  try {
    const list = await readdir(dir, { withFileTypes: true })
    entries = list.map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    }))
  } catch (err) {
    if (isFsNotFound(err)) return 0
    console.error('[dashboard:storage] readdir failed for', dir, err)
    return 0
  }

  let total = 0
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory) {
      total += await sumDirectoryBytes(full)
    } else if (entry.isFile) {
      try {
        const s = await stat(full)
        total += s.size
      } catch (err) {
        if (!isFsNotFound(err)) {
          console.error('[dashboard:storage] stat failed for', full, err)
        }
      }
    }
  }
  return total
}

/** True for Node-style filesystem "no such file or directory" errors. */
function isFsNotFound(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT'
}
