/**
 * Per-scope AI defaults — CRUD over `ai_defaults`.
 *
 * One row per scope (`site`, `content`, `data`, `plugin`). Each row points
 * at a specific `credential_id` (FK with `on delete restrict` — deleting
 * the default credential is rejected at the DB layer; the UI nudges to
 * reassign first).
 *
 * Defaults are site-wide (not per-user). Setting requires the
 * `ai.providers.manage` capability; reading requires `ai.use`.
 */

import { api, getConvex } from '../../convex/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import type { ToolScope } from '../runtime/types'

// ---------------------------------------------------------------------------
// Records + views
// ---------------------------------------------------------------------------

interface DefaultRecord {
  readonly scope: ToolScope
  readonly credentialId: string
  readonly modelId: string
  readonly updatedAt: string
  readonly updatedBy: string | null
}

interface DefaultRow {
  scope: string
  credential_id: string
  model_id: string
  updated_at: Date | string
  updated_by: string | null
}

function rowToRecord(row: DefaultRow): DefaultRecord {
  return {
    scope: row.scope as ToolScope,
    credentialId: row.credential_id,
    modelId: row.model_id,
    updatedAt: isoDateOrNull(row.updated_at)!,
    updatedBy: row.updated_by,
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listDefaults(): Promise<DefaultRecord[]> {
  const rows = await getConvex().query(api.aiDefaults.list, {})
  return rows.map(rowToRecord)
}

// ---------------------------------------------------------------------------
// Write — upsert (read-by-index → patch-or-insert, §4.6)
// ---------------------------------------------------------------------------

export async function setDefaultForScope(
  scope: ToolScope,
  credentialId: string,
  modelId: string,
  updatedByUserId: string | null,
): Promise<DefaultRecord> {
  const row = await getConvex().mutation(api.aiDefaults.setForScope, {
    scope,
    credentialId,
    modelId,
    updatedBy: updatedByUserId,
  })
  return rowToRecord(row)
}

export async function clearDefaultForScope(
  scope: ToolScope,
): Promise<void> {
  await getConvex().mutation(api.aiDefaults.clearForScope, { scope })
}
