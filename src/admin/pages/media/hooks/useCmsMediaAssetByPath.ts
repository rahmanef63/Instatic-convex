/**
 * useCmsMediaAssetByPath — fetch the CMS media asset whose `publicPath`
 * matches a given URL, with module-level memoisation so dozens of image
 * modules on the same page share one round-trip per unique path.
 *
 * Why publicPath, not id? The Image / Video modules store the asset's
 * public URL (`/uploads/<storage>`) on the prop — the same value used as
 * the `src` attribute. The server-side `prefetchMediaAssets` pre-pass
 * also joins by `public_path`, so editor preview and published HTML
 * resolve identically.
 *
 * Cache key: the `publicPath` string. The first hook call for a given
 * path fires `listCmsMediaAssets()` (one round trip) and caches the
 * matched asset; subsequent calls (or remounts) hit the cache. Cache
 * invalidates on `refreshCmsMediaAssetCache()` — call after a replace /
 * delete so stale rows don't linger.
 */
import { useEffect, useState } from 'react'
import { listCmsMediaAssets, type CmsMediaAsset } from '@core/persistence/cmsMedia'

// Module-level cache, shared across every consumer. CmsMediaAsset objects
// are small (< 1 KB each), so a Map of every asset the user has touched
// in this session is negligible memory.
const cache = new Map<string, CmsMediaAsset>()
let listPromise: Promise<CmsMediaAsset[]> | null = null
const subscribers = new Set<() => void>()

function ensureList(): Promise<CmsMediaAsset[]> {
  if (listPromise) return listPromise
  listPromise = listCmsMediaAssets()
    .then((assets) => {
      for (const asset of assets) cache.set(asset.publicPath, asset)
      for (const sub of subscribers) sub()
      return assets
    })
    .catch((err) => {
      // Reset so a retry can re-issue the fetch.
      listPromise = null
      throw err
    })
  return listPromise
}

/**
 * Drop the cache so the next consumer re-fetches. Call after a
 * mutation that may have changed the asset list (upload, replace,
 * delete) if you need stale rows out of the editor preview.
 */
export function refreshCmsMediaAssetCache(): void {
  cache.clear()
  listPromise = null
  for (const sub of subscribers) sub()
}

export function useCmsMediaAssetByPath(publicPath: string | null | undefined): CmsMediaAsset | null {
  // Tiny state so the component re-renders when the cache populates. The
  // value itself comes from the module-level Map.
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!publicPath) return
    if (cache.has(publicPath)) return
    let canceled = false
    void ensureList()
      .then(() => { if (!canceled) setTick((n) => n + 1) })
      .catch(() => { /* swallow — editor still renders raw src */ })
    return () => { canceled = true }
  }, [publicPath])

  // Subscribe to cache invalidation so refresh() bumps every consumer.
  useEffect(() => {
    const sub = () => setTick((n) => n + 1)
    subscribers.add(sub)
    return () => { subscribers.delete(sub) }
  }, [])

  return publicPath ? cache.get(publicPath) ?? null : null
}
