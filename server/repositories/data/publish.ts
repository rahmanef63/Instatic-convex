/**
 * Data access for published data rows.
 *
 *   persistDataRowPublish         — transactional write of one row publish:
 *                                   append a new data_row_versions row, flip
 *                                   the row to `published`, write
 *                                   `active_version_id`, and (when the slug
 *                                   changed) record a redirect from the
 *                                   previous public path
 *   getPublishedDataRowByRoute    — resolve a public URL to the active
 *                                   published version of a row; resolves
 *                                   `featuredMediaPath` via a second query
 *                                   against `media_assets` (app code reads the
 *                                   cell value — SQL stays dialect-naive)
 *   getDataRowRedirectByRoute     — resolve a public URL to a redirect target
 *                                   when the URL belongs to a
 *                                   previously-published slug
 *   listPublishedRowRoutes        — every published row route (for the bake)
 *   getRowTableRouteInfo          — route base + table slug for one row
 *   getRowTableRouteBase          — route base only, ignoring soft deletes
 *
 * Data access ONLY. The row-publish orchestration (publish lock, Layer A
 * artefact writes, cache bump) lives in `server/publish/publishRow.ts` and
 * calls down into this repository.
 */
import type { DbClient } from '../../db/client'
import { api, getConvex } from '../../convex/client'
import type { DataRow, DataRowVersion, DataRowRedirect, PublishedDataRow } from '@core/data/schemas'
import { normalizeRouteBase } from '@core/templates/templateMatching'

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The public route a row's previously-published version was served under. */
export interface PreviousPublishedRoute {
  slug: string
  routeBase: string
}

export interface PersistDataRowPublishResult {
  row: DataRow
  version: DataRowVersion
  /**
   * The route of the version that was active BEFORE this publish, or `null`
   * on a first publish. The orchestrator uses it to prune the stale Layer A
   * artefact when the slug changed.
   */
  previousRoute: PreviousPublishedRoute | null
}

export interface RowTableRouteInfo {
  tableRouteBase: string
  tableSlug: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Public URL path for a row: `<normalized route base>/<slug>`. */
export function publicDataPath(routeBase: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(routeBase)
  return `${normalizedBase === '/' ? '' : normalizedBase}/${slug}`
}

/** True when the previously-published route differs from the current slug's. */
export function previousRouteChanged(previous: PreviousPublishedRoute, currentSlug: string): boolean {
  return (
    previous.slug.length > 0 &&
    publicDataPath(previous.routeBase, previous.slug) !==
      publicDataPath(previous.routeBase, currentSlug)
  )
}

// ---------------------------------------------------------------------------
// Publish persistence
// ---------------------------------------------------------------------------

/**
 * Transactional write of one row publish — one atomic Convex mutation
 * (`api.dataPublish.persistRowPublish`, docs/CONVEX-MIGRATION.md §3 #8). The
 * mutation allocates the version number atomically (read current max for the
 * row, insert max+1), appends the version, flips the row to `published`, and
 * upserts the redirect when the slug changed. DB writes only — the publish
 * lock, artefact bake, and cache bump are owned by `server/publish/publishRow.ts`.
 */
export async function persistDataRowPublish(
  _db: DbClient,
  rowId: string,
  /**
   * The user attributed as the publisher. `null` is allowed for system
   * actors that have no user context — e.g. the scheduled-publish tick
   * (`server/publish/publishScheduler.ts`) which fires once
   * `scheduled_publish_at` is in the past. The `published_by_user_id`
   * column on `data_rows` is nullable (`on delete set null`), so a
   * null publisher round-trips cleanly through the schema.
   */
  publisherUserId: string | null,
): Promise<PersistDataRowPublishResult> {
  return getConvex().mutation(api.dataPublish.persistRowPublish, {
    rowId,
    publisherUserId,
  })
}

// ---------------------------------------------------------------------------
// Route info lookups
// ---------------------------------------------------------------------------

/**
 * Fetch the `route_base` and `slug` of the `data_tables` row that owns
 * the given data row. Used by the artefact writer in
 * `server/publish/publishRow.ts` to resolve the public URL path without
 * joining the table into every other query.
 */
export async function getRowTableRouteInfo(
  _db: DbClient,
  rowId: string,
): Promise<RowTableRouteInfo | null> {
  const info = await getConvex().query(api.dataPublish.rowTableRouteInfo, { rowId })
  if (!info) return null
  return {
    tableRouteBase: normalizeRouteBase(info.routeBase),
    tableSlug: info.tableSlug,
  }
}

/**
 * The owning table's raw `route_base` for a row, resolved WITHOUT the
 * `deleted_at is null` filters — artefact removal must still resolve the
 * route after a soft delete (ISS-039).
 */
export async function getRowTableRouteBase(
  _db: DbClient,
  rowId: string,
): Promise<string | null> {
  return getConvex().query(api.dataPublish.rowTableRouteBase, { rowId })
}

// ---------------------------------------------------------------------------
// Public-route lookups
// ---------------------------------------------------------------------------

interface PublishedRowRoute {
  rowId: string
  /** Slug of the row's ACTIVE published version (what the public URL uses). */
  rowSlug: string
  tableSlug: string
  tableRouteBase: string
}

/**
 * Every published, non-deleted data row (excluding the `pages` table) with
 * its active version's slug and its table's route info. The full publish uses
 * this to bake a Layer A artefact for each row route into the fresh slot —
 * without it, the slot swap would strand every row artefact written by
 * incremental publishes.
 */
export async function listPublishedRowRoutes(_db: DbClient): Promise<PublishedRowRoute[]> {
  const rows = await getConvex().query(api.dataPublish.listPublishedRowRoutes, {})
  return rows.map((row) => ({
    rowId: row.rowId,
    rowSlug: row.rowSlug,
    tableSlug: row.tableSlug,
    tableRouteBase: normalizeRouteBase(row.tableRouteBase),
  }))
}

/**
 * Resolve a public URL (tableRouteBase + rowSlug) to the active published
 * version of a data row.
 *
 * `featuredMediaPath` is resolved in app code: first we read
 * `cells.featuredMedia` (via `readFeaturedMediaCell`) from the version's
 * `cells_json`, then — only when a media id is present — we do a second
 * query against `media_assets` for the `public_path`. This keeps the primary
 * query dialect-naive (no JSON-extract functions, no PG-specific operators).
 */
export async function getPublishedDataRowByRoute(
  _db: DbClient,
  tableRouteBase: string,
  rowSlug: string,
): Promise<PublishedDataRow | null> {
  const normalizedBase = normalizeRouteBase(tableRouteBase)

  // The Convex query hand-joins the table + author + per-version publisher and
  // resolves `featuredMediaPath` via a `media_assets` lookup (the publisher ref
  // targets `data_row_versions.published_by_user_id`, the per-version
  // publisher). `cells` arrives already parsed.
  const queryRow = await getConvex().query(api.dataPublish.publishedDataRowByRoute, {
    normalizedRouteBase: normalizedBase,
    rowSlug,
  })
  if (!queryRow) return null

  return {
    id: queryRow.id,
    rowId: queryRow.rowId,
    tableId: queryRow.tableId,
    tableSlug: queryRow.tableSlug,
    tableKind: queryRow.tableKind as PublishedDataRow['tableKind'],
    tableRouteBase: normalizeRouteBase(queryRow.tableRouteBase),
    versionNumber: queryRow.versionNumber,
    cells: queryRow.cells,
    slug: queryRow.slug,
    featuredMediaId: queryRow.featuredMediaId,
    featuredMediaPath: queryRow.featuredMediaPath,
    authorUserId: queryRow.authorUserId,
    authorName: queryRow.authorName,
    authorRoleSlug: queryRow.authorRoleSlug,
    authorRoleName: queryRow.authorRoleName,
    publishedByUserId: queryRow.publishedByUserId,
    publishedByName: queryRow.publishedByName,
    publishedByRoleSlug: queryRow.publishedByRoleSlug,
    publishedByRoleName: queryRow.publishedByRoleName,
    publishedAt: queryRow.publishedAt,
    createdAt: queryRow.createdAt,
  }
}

export async function getDataRowRedirectByRoute(
  _db: DbClient,
  tableRouteBase: string,
  rowSlug: string,
): Promise<DataRowRedirect | null> {
  const normalizedBase = normalizeRouteBase(tableRouteBase)

  const queryRow = await getConvex().query(api.dataPublish.redirectByRoute, {
    normalizedRouteBase: normalizedBase,
    rowSlug,
  })
  if (!queryRow) return null

  const fromPath = publicDataPath(queryRow.fromRouteBase, queryRow.fromSlug)
  const targetPath = publicDataPath(queryRow.targetRouteBase, queryRow.targetSlug)
  if (fromPath === targetPath) return null

  return { id: queryRow.id, fromPath, targetPath }
}

// ---------------------------------------------------------------------------
// Bundle export / import — raw redirect rows
// ---------------------------------------------------------------------------

/**
 * A redirect serialized for bundle transfer, in raw column form (camelCased).
 * Shape-compatible with `BundleRedirect` in `@core/data/bundleSchema` so the
 * export handler can pass these straight through.
 */
export interface ExportableRedirect {
  id: string
  tableId: string
  fromRouteBase: string
  fromSlug: string
  targetRowId: string
}

/** Every redirect, raw, for a full-site export. */
export async function listExportableRedirects(_db: DbClient): Promise<ExportableRedirect[]> {
  return getConvex().query(api.dataPublish.listExportableRedirects, {})
}

/** Wipe all redirects — used by the `replace` import strategy before reinsert. */
export async function deleteAllDataRowRedirects(_db: DbClient): Promise<void> {
  await getConvex().mutation(api.dataPublish.deleteAllRedirects, {})
}

/**
 * Insert a redirect preserving its original id, upserting on the unique
 * (from_route_base, from_slug) source key. Used by the bundle import handler.
 */
export async function importDataRowRedirect(_db: DbClient, input: ExportableRedirect): Promise<void> {
  await getConvex().mutation(api.dataPublish.importRedirect, {
    id: input.id,
    tableId: input.tableId,
    fromRouteBase: input.fromRouteBase,
    fromSlug: input.fromSlug,
    targetRowId: input.targetRowId,
  })
}
