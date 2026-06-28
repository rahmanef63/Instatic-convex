/**
 * Site bundle import endpoint.
 *
 *   POST /admin/api/cms/import[?strategy=replace|merge-add|merge-overwrite]
 *
 * Accepts a `SiteBundle` JSON body (as produced by GET/POST /admin/api/cms/export)
 * and applies it to the local instance using the specified strategy.
 *
 * Strategies:
 *   replace         (default) — delete everything, reimport from bundle atomically.
 *   merge-add                 — insert rows/tables that don't exist locally; skip
 *                               those whose id already exists. Never overwrites.
 *   merge-overwrite           — upsert rows/tables: add missing, update existing.
 *
 * All DB mutations run inside a single transaction. Media writes happen after
 * the transaction (filesystem); individual media failures log and continue
 * without aborting the import.
 *
 * Capability matrix (G6 fix — was a single `site.structure.edit` for
 * everything, which let a Designer with structure-edit but no
 * content rights wipe every row via the import endpoint):
 *
 *   ALL strategies require:        `data.import`
 *   `replace` strategy ALSO needs: `content.manage` AND step-up
 *                                  (wipe-and-reload is the highest blast
 *                                  radius operation in the CMS)
 *   bundles carrying a `site`:     ALSO `site.structure.edit` (the site
 *                                  shell replace is a structural edit)
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'
import type { DbClient } from '../../db/client'
import { requireCapability, requireStepUp, userHasCapability } from '../../auth/authz'
import { importMediaAsset, assignAssetToFolders } from '../../repositories/media'
import { api, getConvex } from '../../convex/client'
import { jsonResponse, readValidatedBody } from '../../http'
import { parseValue } from '@core/utils/typeboxHelpers'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { normalizeDataTableFields } from '@core/data/fields'
import type { SiteShell } from '@core/page-tree'
import type { DataTable, DataRow } from '@core/data/schemas'
import {
  SiteBundleSchema,
  ImportStrategySchema,
  ImportResultSchema,
  type ImportStrategy,
} from '@core/data/bundleSchema'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'

const CMS_SITE_SCHEMA_VERSION = 1

/**
 * Prepare a bundle `DataTable` for the import mutation: apply the `@core`
 * route/field normalisers Bun-side (they can't run in the Convex V8 runtime)
 * and stringify the fields blob. Mirrors `createDataTable`/`updateDataTable` in
 * `server/repositories/data/tables.ts`.
 */
function prepareTable(table: DataTable) {
  return {
    id: table.id,
    name: table.name,
    slug: table.slug,
    kind: table.kind,
    routeBase: normalizeRouteBase(table.routeBase ?? table.slug),
    singularLabel: table.singularLabel,
    pluralLabel: table.pluralLabel,
    primaryFieldId: table.primaryFieldId,
    fieldsJson: JSON.stringify(normalizeDataTableFields(table.fields ?? [])),
  }
}

/**
 * Prepare a bundle `DataRow` for the import mutation. User-ref columns are
 * dropped on import; `createdAt`/`updatedAt` default to now when absent (mirror
 * of `importArgs` in `server/repositories/data/rows/import.ts`).
 */
function prepareRow(row: DataRow) {
  const now = new Date().toISOString()
  return {
    id: row.id,
    tableId: row.tableId,
    cells: row.cells,
    slug: row.slug,
    status: row.status,
    publishedAt: row.publishedAt ?? null,
    createdAt: row.createdAt ?? now,
    updatedAt: row.updatedAt ?? now,
  }
}

/**
 * Prepare the site shell for the import mutation: split the name out and
 * stringify the storage envelope (mirror of `shellToStorage` +
 * `saveDraftSite` in `server/repositories/site.ts`).
 */
function prepareSite(shell: SiteShell) {
  const { name, ...rest } = shell
  return {
    name,
    settingsJson: JSON.stringify({ cmsSiteSchemaVersion: CMS_SITE_SCHEMA_VERSION, site: rest }),
  }
}

/**
 * Order folders so every parent precedes its children — `media_folders.parent_id`
 * is a self-referencing foreign key, so inserts must be topological. Any folder
 * whose parent isn't in the set is treated as a root (defensive: a malformed
 * bundle never wedges the import).
 */
function orderFoldersParentFirst<T extends { id: string; parentId: string | null }>(
  folders: readonly T[],
): T[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const emitted = new Set<string>()
  const ordered: T[] = []

  const visit = (folder: T): void => {
    if (emitted.has(folder.id)) return
    const parent = folder.parentId !== null ? byId.get(folder.parentId) : undefined
    if (parent) visit(parent)
    emitted.add(folder.id)
    ordered.push(folder)
  }

  for (const folder of folders) visit(folder)
  return ordered
}

export async function handleImportRoute(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/import`) return null
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, { status: 405 })

  // Base gate — any import requires `data.import`.
  const user = await requireCapability(req, db, 'data.import')
  if (user instanceof Response) return user

  // Parse strategy from query string (default: replace)
  const strategyParam = url.searchParams.get('strategy') ?? 'replace'
  let strategy: ImportStrategy
  try {
    strategy = parseValue(ImportStrategySchema, strategyParam)
  } catch {
    return jsonResponse(
      { error: 'Invalid strategy — must be replace, merge-add, or merge-overwrite' },
      { status: 400 },
    )
  }

  // `replace` strategy = wipe every data row and reinsert. Highest-blast
  // radius operation in the CMS. Require `content.manage` (so a caller
  // with `data.import` but no content rights can still merge-add but not
  // wipe) AND step-up (mirrors users.ts delete / publish.ts publish).
  if (strategy === 'replace') {
    if (!userHasCapability(user, 'content.manage')) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 })
    }
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
  }

  // Parse and validate the bundle body
  const bundle = await readValidatedBody(req, SiteBundleSchema)
  if (!bundle) {
    return jsonResponse({ error: 'Invalid bundle: body does not conform to SiteBundleSchema' }, { status: 400 })
  }

  // Bundles that carry a site shell additionally require
  // `site.structure.edit` — replacing the shell is a structural site edit
  // even when the import strategy is merge-overwrite.
  if (bundle.site) {
    if (!userHasCapability(user, 'site.structure.edit')) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // ---------------------------------------------------------------------------
  // Counters
  // ---------------------------------------------------------------------------
  let tablesAffected = 0
  let rowsInserted = 0
  let rowsReplaced = 0
  let rowsSkipped = 0
  let mediaImported = 0
  let mediaFoldersImported = 0
  let redirectsImported = 0

  // Folder ids that actually landed — asset memberships are restored only for
  // these, so an asset's `folderIds` pointing at a folder we didn't import is
  // silently skipped rather than violating the membership foreign key.
  const importedFolderIds = new Set<string>()

  // ---------------------------------------------------------------------------
  // DB writes — each strategy is ONE atomic Convex mutation
  // (docs/CONVEX-MIGRATION.md §3 #4–#6). All bundle parsing + normalisation is
  // done Bun-side above; the prepared records cross the wire and every ctx.db
  // operation runs inside a single mutation so a crash rolls the whole import
  // back. Counters come back from the mutation.
  // ---------------------------------------------------------------------------

  const preparedTables = bundle.tables.map(prepareTable)
  const preparedRows = bundle.rows.map(prepareRow)
  const preparedSite = bundle.site ? prepareSite(bundle.site) : undefined

  if (strategy === 'replace') {
    // Folder ids that land in `replace` — the handler knows them up front (every
    // bundle folder is imported), so it builds the membership-restore set here
    // rather than round-tripping it back from the mutation.
    const orderedFolders = bundle.mediaFolders
      ? orderFoldersParentFirst(bundle.mediaFolders)
      : undefined
    if (orderedFolders) for (const folder of orderedFolders) importedFolderIds.add(folder.id)

    const result = await getConvex().mutation(api.importExport.replaceAll, {
      tables: preparedTables,
      rows: preparedRows,
      site: preparedSite,
      mediaFolders: orderedFolders,
      redirects: bundle.redirects,
    })
    tablesAffected = result.tablesAffected
    rowsInserted = result.rowsInserted
    mediaFoldersImported = result.mediaFoldersImported
    redirectsImported = result.redirectsImported
  } else if (strategy === 'merge-add') {
    const result = await getConvex().mutation(api.importExport.mergeAdd, {
      tables: preparedTables,
      rows: preparedRows,
    })
    tablesAffected = result.tablesAffected
    rowsInserted = result.rowsInserted
    rowsSkipped = result.rowsSkipped
  } else {
    const result = await getConvex().mutation(api.importExport.mergeUpdate, {
      tables: preparedTables,
      rows: preparedRows,
      site: preparedSite,
    })
    tablesAffected = result.tablesAffected
    rowsInserted = result.rowsInserted
    rowsReplaced = result.rowsReplaced
  }

  // ---------------------------------------------------------------------------
  // Media — outside the DB transaction (filesystem writes)
  // ---------------------------------------------------------------------------
  if (bundle.media && bundle.media.length > 0 && options.uploadsDir) {
    const uploadsDir = options.uploadsDir
    await mkdir(uploadsDir, { recursive: true })

    for (const asset of bundle.media) {
      try {
        // Write the file bytes. The schema already forbids leading-slash and
        // `..` segments, but re-assert containment after join() — a media
        // storagePath is otherwise an arbitrary-file-write primitive (ISS-009).
        const bytes = Buffer.from(asset.bytesBase64, 'base64')
        const target = join(uploadsDir, asset.storagePath)
        assertPathWithin(uploadsDir, target)
        await writeFile(target, bytes)

        // Upsert the media_assets row
        await importMediaAsset(db, {
          id: asset.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          storagePath: asset.storagePath,
          publicPath: `/uploads/${asset.storagePath}`,
          altText: asset.altText,
          caption: asset.caption,
          title: asset.title,
          tags: asset.tags,
          width: asset.width,
          height: asset.height,
          durationMs: asset.durationMs,
          dominantColor: asset.dominantColor,
          blurHash: asset.blurHash,
          posterPath: asset.posterPath,
        })

        // Restore folder membership — but only into folders we actually
        // imported, so a stale folderId can't violate the membership FK.
        const targetFolders = asset.folderIds.filter((id) => importedFolderIds.has(id))
        if (targetFolders.length > 0) {
          await assignAssetToFolders(db, asset.id, { add: targetFolders })
        }

        mediaImported++
      } catch (err) {
        console.error('[import] Failed to import media asset:', asset.id, err)
        // Continue with remaining assets — a single failed asset should not
        // abort the whole import (data is already committed).
      }
    }
  }

  const result = {
    ok: true as const,
    strategy,
    tablesAffected,
    rowsInserted,
    rowsReplaced,
    rowsSkipped,
    mediaImported,
    mediaFoldersImported,
    redirectsImported,
  }

  // Paranoia: validate result shape before returning
  parseValue(ImportResultSchema, result)

  return jsonResponse(result)
}
