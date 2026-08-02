/**
 * Publish repository — data access for published site snapshots.
 *
 * Pages are stored in `data_rows` (table_id = 'pages'). A full publish
 * stores the published `SiteDocument` ONCE in `site_snapshots` (with a
 * content hash and the pre-serialised runtime importmap); each published
 * page version is a row in `data_row_versions` that references it via
 * `site_snapshot_id` and carries only its page-scoped `runtime_assets_json`.
 * Readers reassemble the `PublishedPageSnapshot` shape from the join, so
 * publishing N pages stores the site document once instead of N times.
 *
 * This module is data access ONLY. The full-publish orchestration (runtime
 * builds, rendering, Layer A baking, slot swap, cache bump) lives in
 * `server/publish/publishSite.ts` and calls down into this repository.
 *
 * Public API:
 *   getDraftSiteDocument      — assemble the draft SiteDocument from rows
 *   persistSitePublish        — transactional write of one publish
 *   getPublishedPageBySlug    — look up a published page snapshot by slug
 *   getPublishedPageSnapshotById — same, by page row id
 *   getLatestPublishedSiteSnapshot — first published page snapshot (for 404s etc.)
 *   getDraftPublishStatus     — compare draft vs published state for the UI
 */
import { createHash } from 'node:crypto'
import type { SiteDocument } from '@core/page-tree'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import type { PublishedRuntimePackageImportmap } from '@core/publisher'
import { api, getConvex } from '../convex/client'
import type { BuiltRuntimeAssetFile } from '../publish/runtime/bundleScripts'
import { getDraftSite } from './site'
import { listDataRows } from './data'
import { pageFromRow } from '../../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../../src/core/data/componentFromRow'
import { validateVisualComponents } from '../../src/core/persistence/validate'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishedPageSnapshot {
  cmsSnapshotVersion: 1
  /** id of the `data_rows` row for this page (was `pageId` in the old schema). */
  pageRowId: string
  site: SiteDocument
  runtimeAssets?: PublishedPageRuntimeAssets
  /**
   * Pre-serialised importmap mapping bare specifiers like `three` to URLs
   * served from the host's runtime dependency cache. Stored verbatim in the
   * snapshot so re-renders use the same bytes the CSP hash was computed
   * over. Omitted when the site has no locked runtime dependencies.
   */
  runtimePackageImportmap?: PublishedRuntimePackageImportmap
}

interface DraftPublishStatus {
  hasPublishedVersion: boolean
  draftMatchesPublished: boolean
  draftPages: number
  publishedPages: number
  lastPublishedAt?: string
}

/**
 * Shared shape returned by the Convex snapshot getters below. `site` and
 * `runtimeAssets` cross the Convex `v.any()` channel as opaque JSON (the `@core`
 * shapes cannot enter the Convex runtime), so they arrive untyped and are
 * trusted back into their stored shapes in `snapshotFromQueryRow`.
 */
interface SnapshotQueryRow {
  rowId: string
  site: unknown
  runtimeAssets: unknown
  importmapBody: string | null
  importmapSha256: string | null
}

/** One page's version write within `persistSitePublish`. */
export interface PublishedPageVersionWrite {
  pageId: string
  title: string
  slug: string
  versionId: string
  versionNumber: number
  runtimeAssets: PublishedPageRuntimeAssets | null
  runtimeFiles: BuiltRuntimeAssetFile[]
}

export interface PersistSitePublishInput {
  siteSnapshotId: string
  /** The published site document — stored ONCE, referenced by every page version. */
  site: SiteDocument
  serializedImportmap: { body: string; sha256: string } | null
  pages: PublishedPageVersionWrite[]
  publishedByUserId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Canonical content hash of a site document, stamped on `site_snapshots` at
 * publish time. The publish-status check compares the draft's hash against
 * it — equality is observationally identical to comparing the canonical JSON
 * strings, without fetching or parsing any stored snapshot.
 */
function siteContentHash(site: SiteDocument): string {
  return createHash('sha256').update(canonicalJson(site)).digest('hex')
}

/** Reassemble the `PublishedPageSnapshot` shape from the getter result. */
function snapshotFromQueryRow(row: SnapshotQueryRow): PublishedPageSnapshot {
  // The snapshot was serialised and stored by the publisher, then round-tripped
  // whole through the Convex `v.any()` channel; trust it back into its stored
  // shapes (mirrors the old SQLite row-interface typing of `site_json`).
  const site = row.site as SiteDocument
  const runtimeAssets = row.runtimeAssets as PublishedPageRuntimeAssets | null
  return {
    cmsSnapshotVersion: 1,
    pageRowId: row.rowId,
    site,
    ...(runtimeAssets && runtimeAssets.scripts.length > 0
      ? { runtimeAssets }
      : {}),
    ...(row.importmapBody && row.importmapSha256
      ? { runtimePackageImportmap: { body: row.importmapBody, sha256: row.importmapSha256 } }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Assemble the current draft `SiteDocument` from the site shell plus the
 * `pages` and `components` data rows. Returns `null` when no draft site
 * exists yet. Saved layouts are editor-only; publishing ignores them.
 */
export async function getDraftSiteDocument(): Promise<SiteDocument | null> {
  const shell = await getDraftSite()
  if (!shell) return null

  const [pageRows, vcRows] = await Promise.all([
    listDataRows('pages'),
    listDataRows('components'),
  ])
  const visualComponents = validateVisualComponents(
    vcRows.flatMap((r) => { const vc = visualComponentFromRow(r); return vc ? [vc] : [] })
  )
  return {
    ...shell,
    pages: pageRows.map(pageFromRow),
    visualComponents,
    layouts: [],
  }
}

export async function getDraftPublishStatus(): Promise<DraftPublishStatus> {
  const draftSite = await getDraftSiteDocument()
  if (!draftSite) {
    return {
      hasPublishedVersion: false,
      draftMatchesPublished: false,
      draftPages: 0,
      publishedPages: 0,
    }
  }

  // Only the per-publish content hash is fetched — never the stored site
  // document. Comparing the draft's hash against each row's stamped hash is
  // observationally identical to comparing canonical JSON strings, but costs
  // one draft serialisation instead of one per published page.
  const publishedRows = await getConvex().query(api.dataPublish.listPublishedPageStatus, {})

  const draftSiteHash = siteContentHash(draftSite)
  const draftPageIds = new Set(draftSite.pages.map((page) => page.id))
  const draftMatchesPublished =
    publishedRows.length === draftSite.pages.length &&
    publishedRows.every((row) =>
      draftPageIds.has(row.rowId) &&
      row.contentHash === draftSiteHash
    )
  const lastPublishedAt = publishedRows
    .map((row) => new Date(row.publishedAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]

  return {
    hasPublishedVersion: publishedRows.length > 0,
    draftMatchesPublished,
    draftPages: draftSite.pages.length,
    publishedPages: publishedRows.length,
    ...(lastPublishedAt ? { lastPublishedAt: new Date(lastPublishedAt).toISOString() } : {}),
  }
}

/**
 * Transactional write of one full publish — one atomic Convex mutation
 * (`api.dataPublish.persistSitePublish`, docs/CONVEX-MIGRATION.md §3 #7): the
 * site snapshot row plus one `data_row_versions` row (and its runtime asset
 * files) per page, flipping each page row to `published`. DB writes only —
 * every expensive non-DB build (runtime bundling, rendering) happens in the
 * orchestrator BEFORE this is called.
 *
 * The page-scoped runtime-asset bytes (`v.bytes()` columns) are copied into
 * fresh `ArrayBuffer`s for the Convex transport. The content hash is computed
 * here (Node crypto stays in the Bun server) and stamped on the snapshot; the
 * `*_json` blobs travel as hydrated values and are serialised inside the
 * mutation.
 */
export async function persistSitePublish(
  input: PersistSitePublishInput,
): Promise<void> {
  await getConvex().mutation(api.dataPublish.persistSitePublish, {
    siteSnapshotId: input.siteSnapshotId,
    site: input.site,
    contentHash: siteContentHash(input.site),
    importmapBody: input.serializedImportmap?.body ?? null,
    importmapSha256: input.serializedImportmap?.sha256 ?? null,
    publishedByUserId: input.publishedByUserId,
    pages: input.pages.map((page) => ({
      pageId: page.pageId,
      versionId: page.versionId,
      versionNumber: page.versionNumber,
      title: page.title,
      slug: page.slug,
      runtimeAssets: page.runtimeAssets,
      runtimeFiles: page.runtimeFiles.map((file) => ({
        path: file.path,
        publicPath: file.publicPath,
        contentType: file.contentType,
        // Copy into a standalone ArrayBuffer for the Convex `v.bytes()` channel.
        bytes: new Uint8Array(file.bytes).buffer,
      })),
    })),
  })
}

export async function getPublishedPageBySlug(
  slug: string,
): Promise<PublishedPageSnapshot | null> {
  const row = await getConvex().query(api.dataPublish.publishedPageBySlug, { slug })
  return row ? snapshotFromQueryRow(row) : null
}

export async function getPublishedPageSnapshotById(
  pageId: string,
): Promise<PublishedPageSnapshot | null> {
  const row = await getConvex().query(api.dataPublish.publishedPageById, { pageId })
  return row ? snapshotFromQueryRow(row) : null
}

export async function getLatestPublishedSiteSnapshot(): Promise<PublishedPageSnapshot | null> {
  const row = await getConvex().query(api.dataPublish.latestPublishedSiteSnapshot, {})
  return row ? snapshotFromQueryRow(row) : null
}
