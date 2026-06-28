/**
 * Durable cache of the OpenRouter model catalogue in `ai_model_pricing`.
 *
 * The catalogue is small (Anthropic + OpenAI models only — tens of rows), so
 * we replace it wholesale on each refresh inside one transaction rather than
 * diffing. The DB copy is the cold-start fallback: if OpenRouter is
 * unreachable when the server boots, the last-known prices + context windows
 * still serve turns and the picker.
 */

import type { DbClient } from '../../db/client'
import { api, getConvex } from '../../convex/client'
import type { ModelCatalogue } from './openrouterCatalogue'

/** Load the cached catalogue. Returns null when the cache has never been
 *  populated, so the caller knows to block on a first live fetch. */
export async function loadCachedCatalogue(_db: DbClient): Promise<ModelCatalogue | null> {
  const rows = await getConvex().query(api.aiPricing.list, {})
  if (rows.length === 0) return null

  const catalogue: ModelCatalogue = new Map()
  for (const row of rows) {
    catalogue.set(row.pricing_key, {
      prices: {
        inputPerMTok: row.input_per_mtok,
        outputPerMTok: row.output_per_mtok,
        cacheReadPerMTok: row.cache_read_per_mtok,
        cacheWritePerMTok: row.cache_write_per_mtok,
      },
      contextWindow: row.context_window,
    })
  }
  return catalogue
}

/** Replace the cached catalogue wholesale (delete-all + insert, §3 #13). */
export async function saveCachedCatalogue(_db: DbClient, catalogue: ModelCatalogue): Promise<void> {
  const entries = [...catalogue].map(([key, entry]) => ({
    pricingKey: key,
    inputPerMtok: entry.prices.inputPerMTok,
    outputPerMtok: entry.prices.outputPerMTok,
    cacheReadPerMtok: entry.prices.cacheReadPerMTok,
    cacheWritePerMtok: entry.prices.cacheWritePerMTok,
    contextWindow: entry.contextWindow,
  }))
  await getConvex().mutation(api.aiPricing.saveCatalogue, { entries })
}
