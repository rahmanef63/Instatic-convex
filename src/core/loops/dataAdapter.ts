/**
 * Loop data adapter — the injected data port the built-in `data.rows` and
 * `site.media` loop sources read through.
 *
 * `src/core/loops/` stays free of server-only imports, so it never reaches the
 * Convex client directly. The Bun server fills this port at boot
 * (`server/loops/adapter.ts`) with `convex/loops.ts`-backed implementations;
 * the sources keep their LoopItem projection + media-path resolution here in
 * `@core` (it depends on `@core` helpers that must not run in Convex's V8
 * runtime). This mirrors the old injected `LoopSourceDb` seam — raw rows in,
 * projection in `@core` — with typed methods instead of SQL.
 */

/** A published post-type row joined to its active version + author/publisher. */
export interface PublishedDataRowRecord {
  version_id: string
  row_id: string
  table_id: string
  table_slug: string
  table_route_base: string
  version_number: number
  cells_json: Record<string, unknown>
  slug: string
  author_user_id: string | null
  author_display_name: string | null
  author_role_slug: string | null
  author_role_name: string | null
  published_by_user_id: string | null
  published_by_display_name: string | null
  published_by_role_slug: string | null
  published_by_role_name: string | null
  published_at: string
  created_at: string
  updated_at: string
}

/** A data-kind row (no version workflow) joined to its author. */
export interface DataKindRowRecord {
  row_id: string
  table_id: string
  table_slug: string
  table_route_base: string
  cells_json: Record<string, unknown>
  slug: string
  author_user_id: string | null
  author_display_name: string | null
  author_role_slug: string | null
  author_role_name: string | null
  created_at: string
  updated_at: string
}

export interface MediaAssetRecord {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  public_path: string
  uploaded_by_user_id: string | null
  created_at: string
}

export interface DataRowLoopPage {
  /** `''` when the table is missing/deleted; `'data'` for data-kind; else post-type. */
  kind: string
  postRows: PublishedDataRowRecord[]
  dataRows: DataKindRowRecord[]
  total: number
}

export interface LoopPageQuery {
  orderBy: string
  direction: 'asc' | 'desc'
  limit: number
  offset: number
}

export interface LoopDataAdapter {
  dataRowLoop(query: LoopPageQuery & { tableId: string }): Promise<DataRowLoopPage>
  resolveMediaPaths(ids: string[]): Promise<Record<string, string>>
  mediaItems(
    query: LoopPageQuery & { mimePrefix: string },
  ): Promise<{ rows: MediaAssetRecord[]; total: number }>
}

let adapter: LoopDataAdapter | null = null

/** Register the server's Convex-backed implementation (called once at boot). */
export function setLoopDataAdapter(next: LoopDataAdapter): void {
  adapter = next
}

export function getLoopDataAdapter(): LoopDataAdapter {
  if (!adapter) {
    throw new Error(
      '[loops] data adapter not configured — call setLoopDataAdapter() at server boot',
    )
  }
  return adapter
}
