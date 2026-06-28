/**
 * Internal mapping building blocks shared by the data-row query modules.
 *
 *   DataRowRow     — the joined row shape returned by `convex/dataRows.ts`
 *                    (base columns + the four user-ref column groups)
 *   mapRow         — DataRowRow → DataRow domain shape (camelCase), hydrating
 *                    the four user refs through the shared `userRefAt`
 *   isOwnedByUser  — effective-owner predicate for visibility filters
 *
 * Nothing here is part of the repository's public surface — the barrel
 * (`./index`) does not re-export this module. Sibling query modules import
 * these helpers directly.
 *
 * Convex port: the hydration is hand-assembled in `convex/dataRows.ts`, which
 * returns the `DataRowRow` shape (the user-ref columns already resolved). This
 * module no longer issues SQL — `userRefAt` (the JS hydrator in
 * `../shared.ts`) maps those resolved columns into `DataUserReference`s exactly
 * as it did for the SQL joins.
 */
import type { DataRow, DataRowCells, DataRowStatus } from '@core/data/schemas'
import { userRefAt, type UserJoinColumns } from '../shared'
import { isoDate, isoDateOrNull } from '@core/utils/isoDate'

// ---------------------------------------------------------------------------
// Input shapes (shared by the single-row and bulk write modules)
// ---------------------------------------------------------------------------

export interface InsertDataRowInput {
  id?: string
  tableId: string
  cells: DataRowCells
  /**
   * Denormalized slug derived from `cells.slug` (when the table has a slug
   * field) by the handler before calling this repo. Pass empty string for
   * tables that have no slug field.
   */
  slug: string
}

export interface UpdateDataRowDraftInput {
  cells: DataRowCells
  slug: string
}

// ---------------------------------------------------------------------------
// Joined row shape returned by convex/dataRows.ts
// ---------------------------------------------------------------------------

export interface DataRowRow extends UserJoinColumns {
  id: string
  table_id: string
  cells_json: Record<string, unknown>
  slug: string
  status: DataRowStatus
  author_user_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  published_by_user_id: string | null
  created_at: string | Date
  updated_at: string | Date
  published_at: string | Date | null
  scheduled_publish_at: string | Date | null
  deleted_at: string | Date | null
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

export function mapRow(row: DataRowRow): DataRow {
  return {
    id: row.id,
    tableId: row.table_id,
    cells: row.cells_json,
    slug: row.slug,
    status: row.status,
    authorUserId: row.author_user_id ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    publishedByUserId: row.published_by_user_id ?? null,
    author: userRefAt(row, 'author'),
    createdBy: userRefAt(row, 'created_by'),
    updatedBy: userRefAt(row, 'updated_by'),
    publishedBy: userRefAt(row, 'published_by'),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    publishedAt: isoDateOrNull(row.published_at),
    scheduledPublishAt: isoDateOrNull(row.scheduled_publish_at),
    deletedAt: isoDateOrNull(row.deleted_at),
  }
}

export function isOwnedByUser(row: DataRow, ownerUserId: string): boolean {
  if (row.authorUserId === ownerUserId) return true
  if (row.authorUserId === null) return row.createdByUserId === ownerUserId
  return false
}
