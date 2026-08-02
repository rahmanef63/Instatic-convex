/**
 * Server-side loop data adapter — fills the injected `@core/loops/dataAdapter`
 * port with `convex/loops.ts`-backed implementations.
 *
 * The built-in `data.rows` / `site.media` loop sources live in `src/core` and
 * read their data through this port (raw rows in, LoopItem projection in
 * `@core`). Registered once at server boot (`server/index.ts`).
 */

import { setLoopDataAdapter } from '@core/loops/dataAdapter'
import { api, getConvex } from '../convex/client'

export function registerLoopDataAdapter(): void {
  setLoopDataAdapter({
    dataRowLoop: (query) => getConvex().query(api.loops.dataRowLoop, query),
    resolveMediaPaths: (ids) => getConvex().query(api.loops.mediaPaths, { ids }),
    mediaItems: (query) => getConvex().query(api.loops.mediaItems, query),
  })
}
