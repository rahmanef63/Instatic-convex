/**
 * Publish persistence — Convex functions.
 *
 * The Convex half of the publish domain. The thin repository adapters
 * (`server/repositories/publish.ts` and `server/repositories/data/publish.ts`)
 * marshal args into these and return their results unchanged. All durable
 * publish logic lives here — the heaviest transactions in the system collapse
 * into single atomic mutations (docs/CONVEX-MIGRATION.md §3 #7 + #8):
 *
 * - `persistRowPublish`  — append a `data_row_versions` row, flip the row to
 *   `published`, and (when the slug changed) upsert a `data_row_redirects`
 *   entry. The version number is allocated ATOMICALLY here (read current max
 *   for the row via `by_row_version`, insert max+1) — no round-trip to the
 *   tables-unit allocator (§4.6 read-before-write inside one mutation).
 * - `persistSitePublish` — insert one `site_snapshots` row, then per page:
 *   insert a `data_row_versions` row + its `published_runtime_assets` files +
 *   flip the page row to `published`. Reap-protection: a page concurrently
 *   soft-deleted before this publish drops its just-written version (and its
 *   runtime assets) instead of leaving an orphan pointing at it.
 *
 * Conventions (docs/CONVEX-MIGRATION.md §2, §4, §6):
 * - App identity is the nanoid `id`, generated here on insert. `created_at` /
 *   `published_at` / `updated_at` replace SQL `current_timestamp` defaults and
 *   are stamped here. Convex `_id` never leaks out.
 * - `*_json` blobs are opaque `v.string()` at rest; reads `JSON.parse` them and
 *   return the hydrated value via `v.any()`, writes accept the hydrated value
 *   via `v.any()` and `JSON.stringify` it (mirrors `convex/userPreferences.ts`).
 * - The `LEFT JOIN users`/`roles` user-ref hydration becomes a hand-assembled
 *   join (`hydrateDataRow`) — fetch each user + role by index, build the
 *   `DataUserReference` shape (§4.2). The mapping mirrors
 *   `server/repositories/data/shared.ts` `userRefAt` (server modules cannot be
 *   imported into the Convex bundle).
 * - The `ON CONFLICT (from_route_base, from_slug)` redirect upsert becomes a
 *   read-by-`by_source` → patch-or-insert inside the atomic mutation (§4.6).
 * - `normalizeRouteBase` / `publicDataPath` are re-declared here (pure string
 *   logic mirroring `@core/templates/templateMatching`) because the redirect
 *   decision derives from data read INSIDE the atomic mutation.
 * - Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/publish.ts          — site-publish repository adapter
 * @see server/repositories/data/publish.ts      — row-publish repository adapter
 */

import { v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query } from './_generated/server'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

// ---------------------------------------------------------------------------
// Pure helpers (mirrors of @core — server modules can't enter the Convex bundle)
// ---------------------------------------------------------------------------

/** Mirror of `@core/templates/templateMatching` `normalizeRouteBase`. */
function normalizeRouteBase(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '/'
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/g, '')
  return withoutTrailingSlash || '/'
}

/** Mirror of `server/repositories/data/publish.ts` `publicDataPath`. */
function publicDataPath(routeBase: string, slug: string): string {
  const normalizedBase = normalizeRouteBase(routeBase)
  return `${normalizedBase === '/' ? '' : normalizedBase}/${slug}`
}

/** Mirror of `server/repositories/data/publish.ts` `previousRouteChanged`. */
function previousRouteChanged(
  previousSlug: string,
  previousRouteBase: string,
  currentSlug: string,
): boolean {
  return (
    previousSlug.length > 0 &&
    publicDataPath(previousRouteBase, previousSlug) !==
      publicDataPath(previousRouteBase, currentSlug)
  )
}

// One typed lookup-by-app-id helper per table (mirrors `rowByAppId` in
// convex/dataRows.ts — a generic over the table union can't unify the `eq('id',
// …)` field path across tables under strict mode).
const rowByAppId = (ctx: QueryCtx | MutationCtx, id: string) =>
  ctx.db.query('data_rows').withIndex('by_app_id', (q) => q.eq('id', id)).unique()

const tableByAppId = (ctx: QueryCtx | MutationCtx, id: string) =>
  ctx.db.query('data_tables').withIndex('by_app_id', (q) => q.eq('id', id)).unique()

const versionByAppId = (ctx: QueryCtx | MutationCtx, id: string) =>
  ctx.db.query('data_row_versions').withIndex('by_app_id', (q) => q.eq('id', id)).unique()

const mediaByAppId = (ctx: QueryCtx | MutationCtx, id: string) =>
  ctx.db.query('media_assets').withIndex('by_app_id', (q) => q.eq('id', id)).unique()

const snapshotByAppId = (ctx: QueryCtx | MutationCtx, id: string) =>
  ctx.db.query('site_snapshots').withIndex('by_app_id', (q) => q.eq('id', id)).unique()

const runtimeAssetByAppId = (ctx: QueryCtx | MutationCtx, id: string) =>
  ctx.db
    .query('published_runtime_assets')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const dataRowStatusValidator = v.union(
  v.literal('draft'),
  v.literal('published'),
  v.literal('unpublished'),
  v.literal('scheduled'),
)

const userRefValidator = v.union(
  v.null(),
  v.object({
    id: v.string(),
    email: v.string(),
    displayName: v.string(),
    roleSlug: v.union(v.string(), v.null()),
    roleName: v.union(v.string(), v.null()),
  }),
)

/** Matches the repository's `DataRow` (@core/data/schemas). */
const dataRowValidator = v.object({
  id: v.string(),
  tableId: v.string(),
  cells: v.record(v.string(), v.any()),
  slug: v.string(),
  status: dataRowStatusValidator,
  authorUserId: v.union(v.null(), v.string()),
  createdByUserId: v.union(v.null(), v.string()),
  updatedByUserId: v.union(v.null(), v.string()),
  publishedByUserId: v.union(v.null(), v.string()),
  author: userRefValidator,
  createdBy: userRefValidator,
  updatedBy: userRefValidator,
  publishedBy: userRefValidator,
  createdAt: v.string(),
  updatedAt: v.string(),
  publishedAt: v.union(v.null(), v.string()),
  scheduledPublishAt: v.union(v.null(), v.string()),
  deletedAt: v.union(v.null(), v.string()),
})

/** Matches the repository's `DataRowVersion` (@core/data/schemas). */
const dataRowVersionValidator = v.object({
  id: v.string(),
  rowId: v.string(),
  versionNumber: v.number(),
  cells: v.record(v.string(), v.any()),
  slug: v.string(),
  publishedByUserId: v.union(v.null(), v.string()),
  publishedAt: v.string(),
  createdAt: v.string(),
})

const previousRouteValidator = v.union(
  v.null(),
  v.object({ slug: v.string(), routeBase: v.string() }),
)

// ---------------------------------------------------------------------------
// Hydration — mirrors data/rows/mapper.ts `mapRow` + shared.ts `userRefAt`
// ---------------------------------------------------------------------------

interface UserRef {
  id: string
  email: string
  displayName: string
  roleSlug: string | null
  roleName: string | null
}

/** Build a `DataUserReference` from a resolved user + role (mirror of `buildUserRef`). */
function buildUserRef(
  user: Doc<'users'> | null,
  role: Doc<'roles'> | null,
): UserRef | null {
  if (!user) return null
  const resolvedEmail = user.email ?? ''
  return {
    id: user.id,
    email: resolvedEmail,
    displayName: user.display_name ?? resolvedEmail ?? user.id,
    roleSlug: role?.slug ?? null,
    roleName: role?.name ?? null,
  }
}

/**
 * Resolve a user id to its `DataUserReference`, hand-joining `users` + `roles`
 * by app id. Returns `null` for a null id or a missing user (the old INNER-join
 * "row disappears" semantics).
 */
async function resolveUserRef(
  ctx: QueryCtx | MutationCtx,
  userId: string | null,
  cache: Map<string, UserRef | null>,
): Promise<UserRef | null> {
  if (!userId) return null
  const cached = cache.get(userId)
  if (cached !== undefined) return cached
  const user = await ctx.db
    .query('users')
    .withIndex('by_app_id', (q) => q.eq('id', userId))
    .unique()
  const role = user
    ? await ctx.db
        .query('roles')
        .withIndex('by_app_id', (q) => q.eq('id', user.role_id))
        .unique()
    : null
  const ref = buildUserRef(user, role)
  cache.set(userId, ref)
  return ref
}

/** Hydrate a `data_rows` document into the repository's `DataRow` shape. */
async function hydrateDataRow(ctx: QueryCtx | MutationCtx, row: Doc<'data_rows'>) {
  const cache = new Map<string, UserRef | null>()
  const [author, createdBy, updatedBy, publishedBy] = await Promise.all([
    resolveUserRef(ctx, row.author_user_id, cache),
    resolveUserRef(ctx, row.created_by_user_id, cache),
    resolveUserRef(ctx, row.updated_by_user_id, cache),
    resolveUserRef(ctx, row.published_by_user_id, cache),
  ])
  return {
    id: row.id,
    tableId: row.table_id,
    cells: JSON.parse(row.cells_json) as Record<string, unknown>,
    slug: row.slug,
    status: row.status,
    authorUserId: row.author_user_id ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    publishedByUserId: row.published_by_user_id ?? null,
    author,
    createdBy,
    updatedBy,
    publishedBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at ?? null,
    scheduledPublishAt: row.scheduled_publish_at ?? null,
    deletedAt: row.deleted_at ?? null,
  }
}

// ---------------------------------------------------------------------------
// Row publish (§3 #8)
// ---------------------------------------------------------------------------

/**
 * Persist one row publish in a single atomic mutation: allocate the next
 * version number, append the version, flip the row to `published`, and upsert a
 * redirect when the published slug changed since the previously-active version.
 */
export const persistRowPublish = mutation({
  args: {
    rowId: v.string(),
    publisherUserId: v.union(v.null(), v.string()),
  },
  returns: v.object({
    row: dataRowValidator,
    version: dataRowVersionValidator,
    previousRoute: previousRouteValidator,
  }),
  handler: async (ctx, { rowId, publisherUserId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) throw new Error('data row not found')

    // Route the previously-active published version was served under (for the
    // redirect decision), resolved BEFORE we flip active_version_id.
    let previousRoute: { slug: string; routeBase: string } | null = null
    if (row.active_version_id) {
      const activeVersion = await versionByAppId(ctx, row.active_version_id)
      const table = await tableByAppId(ctx, row.table_id)
      if (activeVersion && table && table.deleted_at === null) {
        previousRoute = { slug: activeVersion.slug, routeBase: table.route_base }
      }
    }

    // Allocate version_number atomically: current max for this row + 1.
    const latest = await ctx.db
      .query('data_row_versions')
      .withIndex('by_row_version', (q) => q.eq('row_id', row.id))
      .order('desc')
      .first()
    const versionNumber = (latest?.version_number ?? 0) + 1
    const versionId = nanoid()
    const now = new Date().toISOString()

    await ctx.db.insert('data_row_versions', {
      id: versionId,
      row_id: row.id,
      version_number: versionNumber,
      cells_json: row.cells_json,
      slug: row.slug,
      published_by_user_id: publisherUserId,
      published_at: now,
      created_at: now,
      site_snapshot_id: null,
      runtime_assets_json: null,
    })

    await ctx.db.patch(row._id, {
      status: 'published',
      active_version_id: versionId,
      published_by_user_id: publisherUserId,
      published_at: now,
      updated_by_user_id: publisherUserId,
      updated_at: now,
    })

    if (
      previousRoute &&
      previousRouteChanged(previousRoute.slug, previousRoute.routeBase, row.slug)
    ) {
      const fromRouteBase = normalizeRouteBase(previousRoute.routeBase)
      const fromSlug = previousRoute.slug
      const existing = await ctx.db
        .query('data_row_redirects')
        .withIndex('by_source', (q) =>
          q.eq('from_route_base', fromRouteBase).eq('from_slug', fromSlug),
        )
        .first()
      if (existing) {
        await ctx.db.patch(existing._id, {
          table_id: row.table_id,
          target_row_id: row.id,
        })
      } else {
        await ctx.db.insert('data_row_redirects', {
          id: nanoid(),
          table_id: row.table_id,
          from_route_base: fromRouteBase,
          from_slug: fromSlug,
          target_row_id: row.id,
          created_at: now,
        })
      }
    }

    const publishedDoc = await rowByAppId(ctx, row.id)
    if (!publishedDoc) throw new Error('data row could not be re-read after publish')
    const publishedRow = await hydrateDataRow(ctx, publishedDoc)

    const publishedAt = publishedRow.publishedAt ?? now
    return {
      row: publishedRow,
      version: {
        id: versionId,
        rowId: publishedRow.id,
        versionNumber,
        cells: publishedRow.cells,
        slug: publishedRow.slug,
        publishedByUserId: publisherUserId,
        publishedAt,
        createdAt: publishedAt,
      },
      previousRoute,
    }
  },
})

// ---------------------------------------------------------------------------
// Site publish (§3 #7)
// ---------------------------------------------------------------------------

/**
 * Persist one full site publish in a single atomic mutation: the site snapshot
 * row, then per page a version row + its runtime-asset files + the page row's
 * flip to `published`. A page reaped before this publish drops its just-written
 * version (and runtime assets) rather than stranding an orphan.
 */
export const persistSitePublish = mutation({
  args: {
    siteSnapshotId: v.string(),
    site: v.any(),
    contentHash: v.string(),
    importmapBody: v.union(v.null(), v.string()),
    importmapSha256: v.union(v.null(), v.string()),
    publishedByUserId: v.string(),
    pages: v.array(
      v.object({
        pageId: v.string(),
        versionId: v.string(),
        versionNumber: v.number(),
        title: v.string(),
        slug: v.string(),
        runtimeAssets: v.any(),
        runtimeFiles: v.array(
          v.object({
            path: v.string(),
            publicPath: v.string(),
            contentType: v.string(),
            bytes: v.bytes(),
          }),
        ),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = new Date().toISOString()

    // The site document is stored ONCE per publish; every page version
    // references it via site_snapshot_id.
    await ctx.db.insert('site_snapshots', {
      id: args.siteSnapshotId,
      site_json: JSON.stringify(args.site),
      content_hash: args.contentHash,
      importmap_body: args.importmapBody,
      importmap_sha256: args.importmapSha256,
      created_at: now,
    })

    for (const page of args.pages) {
      await ctx.db.insert('data_row_versions', {
        id: page.versionId,
        row_id: page.pageId,
        version_number: page.versionNumber,
        cells_json: JSON.stringify({ title: page.title, slug: page.slug }),
        slug: page.slug,
        published_by_user_id: args.publishedByUserId,
        published_at: now,
        created_at: now,
        site_snapshot_id: args.siteSnapshotId,
        runtime_assets_json:
          page.runtimeAssets === null ? null : JSON.stringify(page.runtimeAssets),
      })

      const runtimeAssetIds: Array<string> = []
      for (const file of page.runtimeFiles) {
        const assetId = nanoid()
        runtimeAssetIds.push(assetId)
        await ctx.db.insert('published_runtime_assets', {
          id: assetId,
          data_row_version_id: page.versionId,
          asset_path: file.path,
          public_path: file.publicPath,
          content_type: file.contentType,
          content_bytes: file.bytes,
          created_at: now,
        })
      }

      const pageRow = await rowByAppId(ctx, page.pageId)
      if (pageRow && pageRow.deleted_at === null) {
        await ctx.db.patch(pageRow._id, {
          active_version_id: page.versionId,
          status: 'published',
          published_by_user_id: args.publishedByUserId,
          published_at: now,
          updated_by_user_id: args.publishedByUserId,
          updated_at: now,
        })
      } else {
        // The page was reaped between the orchestrator's read and this publish;
        // don't leave an orphan version (or its assets) pointing at it.
        const versionDoc = await versionByAppId(ctx, page.versionId)
        if (versionDoc) await ctx.db.delete(versionDoc._id)
        for (const assetId of runtimeAssetIds) {
          const assetDoc = await runtimeAssetByAppId(ctx, assetId)
          if (assetDoc) await ctx.db.delete(assetDoc._id)
        }
      }
    }
    return null
  },
})

// ---------------------------------------------------------------------------
// Site-publish read queries
// ---------------------------------------------------------------------------

const snapshotQueryRowValidator = v.union(
  v.null(),
  v.object({
    rowId: v.string(),
    site: v.any(),
    runtimeAssets: v.any(),
    importmapBody: v.union(v.null(), v.string()),
    importmapSha256: v.union(v.null(), v.string()),
  }),
)

/** Reassemble the snapshot read shape from a page row + its active version + snapshot. */
async function readPageSnapshot(ctx: QueryCtx, row: Doc<'data_rows'>) {
  if (!row.active_version_id) return null
  const version = await versionByAppId(ctx, row.active_version_id)
  if (!version || !version.site_snapshot_id) return null
  const snap = await snapshotByAppId(ctx, version.site_snapshot_id)
  if (!snap) return null
  return {
    rowId: row.id,
    site: JSON.parse(snap.site_json) as unknown,
    runtimeAssets:
      version.runtime_assets_json === null
        ? null
        : (JSON.parse(version.runtime_assets_json) as unknown),
    importmapBody: snap.importmap_body,
    importmapSha256: snap.importmap_sha256,
  }
}

/** Published page snapshot by the active version's slug (the `pages` table). */
export const publishedPageBySlug = query({
  args: { slug: v.string() },
  returns: snapshotQueryRowValidator,
  handler: async (ctx, { slug }) => {
    const rows = await ctx.db
      .query('data_rows')
      .withIndex('by_table_slug', (q) => q.eq('table_id', 'pages').eq('slug', slug))
      .collect()
    for (const row of rows) {
      if (row.status !== 'published' || row.deleted_at !== null) continue
      const snapshot = await readPageSnapshot(ctx, row)
      if (snapshot) return snapshot
    }
    return null
  },
})

/** Published page snapshot by page row id (the `pages` table). */
export const publishedPageById = query({
  args: { pageId: v.string() },
  returns: snapshotQueryRowValidator,
  handler: async (ctx, { pageId }) => {
    const row = await rowByAppId(ctx, pageId)
    if (
      !row ||
      row.table_id !== 'pages' ||
      row.status !== 'published' ||
      row.deleted_at !== null
    ) {
      return null
    }
    return readPageSnapshot(ctx, row)
  },
})

/** First published page snapshot, ordered by row creation (for 404 fallbacks). */
export const latestPublishedSiteSnapshot = query({
  args: {},
  returns: snapshotQueryRowValidator,
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('data_rows')
      .withIndex('by_table_status_updated', (q) =>
        q.eq('table_id', 'pages').eq('status', 'published'),
      )
      .collect()
    const sorted = rows
      .filter((r) => r.deleted_at === null)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    for (const row of sorted) {
      const snapshot = await readPageSnapshot(ctx, row)
      if (snapshot) return snapshot
    }
    return null
  },
})

/**
 * Publish-status rows for the `pages` table: each published, non-deleted page
 * with its active version's snapshot content hash + publish time. The
 * repository compares these against the freshly-serialised draft hash.
 */
export const listPublishedPageStatus = query({
  args: {},
  returns: v.array(
    v.object({
      rowId: v.string(),
      contentHash: v.string(),
      publishedAt: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query('data_rows')
      .withIndex('by_table_status_updated', (q) =>
        q.eq('table_id', 'pages').eq('status', 'published'),
      )
      .collect()
    const out: Array<{ rowId: string; contentHash: string; publishedAt: string }> = []
    for (const row of rows) {
      if (row.deleted_at !== null || !row.active_version_id) continue
      const version = await versionByAppId(ctx, row.active_version_id)
      if (!version || !version.site_snapshot_id) continue
      const snap = await snapshotByAppId(ctx, version.site_snapshot_id)
      if (!snap) continue
      out.push({
        rowId: row.id,
        contentHash: snap.content_hash,
        publishedAt: version.published_at,
      })
    }
    return out
  },
})

// ---------------------------------------------------------------------------
// Public-route lookups (data rows)
// ---------------------------------------------------------------------------

const publishedDataRowValidator = v.union(
  v.null(),
  v.object({
    id: v.string(),
    rowId: v.string(),
    tableId: v.string(),
    tableSlug: v.string(),
    tableKind: v.string(),
    tableRouteBase: v.string(),
    versionNumber: v.number(),
    cells: v.record(v.string(), v.any()),
    slug: v.string(),
    featuredMediaId: v.union(v.null(), v.string()),
    featuredMediaPath: v.union(v.null(), v.string()),
    authorUserId: v.union(v.null(), v.string()),
    authorName: v.union(v.null(), v.string()),
    authorRoleSlug: v.union(v.null(), v.string()),
    authorRoleName: v.union(v.null(), v.string()),
    publishedByUserId: v.union(v.null(), v.string()),
    publishedByName: v.union(v.null(), v.string()),
    publishedByRoleSlug: v.union(v.null(), v.string()),
    publishedByRoleName: v.union(v.null(), v.string()),
    publishedAt: v.string(),
    createdAt: v.string(),
  }),
)

/** Resolve a user id to its (displayName, roleSlug, roleName) for a published-row ref. */
async function resolvePublishedRef(ctx: QueryCtx, userId: string | null) {
  if (!userId) {
    return { name: null, roleSlug: null, roleName: null }
  }
  const user = await ctx.db
    .query('users')
    .withIndex('by_app_id', (q) => q.eq('id', userId))
    .unique()
  if (!user) return { name: null, roleSlug: null, roleName: null }
  const role = await ctx.db
    .query('roles')
    .withIndex('by_app_id', (q) => q.eq('id', user.role_id))
    .unique()
  return {
    name: user.display_name ?? user.email ?? user.id,
    roleSlug: role?.slug ?? null,
    roleName: role?.name ?? null,
  }
}

/**
 * Resolve a public URL (normalized route base + the active version's slug) to a
 * published data row, hand-joining table + author + per-version publisher, and
 * resolving `featuredMediaPath` via a `media_assets` lookup (the cell value is
 * read here, mirroring `readFeaturedMediaCell` — `cells.featuredMedia`).
 */
export const publishedDataRowByRoute = query({
  args: { normalizedRouteBase: v.string(), rowSlug: v.string() },
  returns: publishedDataRowValidator,
  handler: async (ctx, { normalizedRouteBase, rowSlug }) => {
    const versions = await ctx.db
      .query('data_row_versions')
      .withIndex('by_slug', (q) => q.eq('slug', rowSlug))
      .collect()

    for (const version of versions) {
      const row = await rowByAppId(ctx, version.row_id)
      if (
        !row ||
        row.deleted_at !== null ||
        row.status !== 'published' ||
        row.active_version_id !== version.id
      ) {
        continue
      }
      const table = await tableByAppId(ctx, row.table_id)
      if (!table || table.deleted_at !== null || table.route_base !== normalizedRouteBase) {
        continue
      }

      const cells = JSON.parse(version.cells_json) as Record<string, unknown>
      const rawFeatured = cells.featuredMedia
      const featuredMediaId =
        typeof rawFeatured === 'string' && rawFeatured.length > 0 ? rawFeatured : null
      let featuredMediaPath: string | null = null
      if (featuredMediaId) {
        const asset = await mediaByAppId(ctx, featuredMediaId)
        featuredMediaPath = asset?.public_path ?? null
      }

      const author = await resolvePublishedRef(ctx, row.author_user_id)
      const publishedBy = await resolvePublishedRef(ctx, version.published_by_user_id)

      return {
        id: version.id,
        rowId: version.row_id,
        tableId: row.table_id,
        tableSlug: table.slug,
        tableKind: table.kind,
        tableRouteBase: table.route_base,
        versionNumber: version.version_number,
        cells,
        slug: version.slug,
        featuredMediaId,
        featuredMediaPath,
        authorUserId: row.author_user_id ?? null,
        authorName: author.name,
        authorRoleSlug: author.roleSlug,
        authorRoleName: author.roleName,
        publishedByUserId: version.published_by_user_id ?? null,
        publishedByName: publishedBy.name,
        publishedByRoleSlug: publishedBy.roleSlug,
        publishedByRoleName: publishedBy.roleName,
        publishedAt: version.published_at,
        createdAt: version.created_at,
      }
    }
    return null
  },
})

const redirectRouteValidator = v.union(
  v.null(),
  v.object({
    id: v.string(),
    fromRouteBase: v.string(),
    fromSlug: v.string(),
    targetRouteBase: v.string(),
    targetSlug: v.string(),
  }),
)

/**
 * Resolve a public URL to a redirect's raw source/target route columns. The
 * repository builds the `fromPath`/`targetPath` and applies the
 * same-path no-op guard.
 */
export const redirectByRoute = query({
  args: { normalizedRouteBase: v.string(), rowSlug: v.string() },
  returns: redirectRouteValidator,
  handler: async (ctx, { normalizedRouteBase, rowSlug }) => {
    const redirects = await ctx.db
      .query('data_row_redirects')
      .withIndex('by_source', (q) =>
        q.eq('from_route_base', normalizedRouteBase).eq('from_slug', rowSlug),
      )
      .collect()

    for (const redirect of redirects) {
      const targetRow = await rowByAppId(ctx, redirect.target_row_id)
      if (
        !targetRow ||
        targetRow.status !== 'published' ||
        targetRow.deleted_at !== null ||
        !targetRow.active_version_id
      ) {
        continue
      }
      const table = await tableByAppId(ctx, targetRow.table_id)
      if (!table || table.deleted_at !== null) continue
      const version = await versionByAppId(ctx, targetRow.active_version_id)
      if (!version) continue
      return {
        id: redirect.id,
        fromRouteBase: redirect.from_route_base,
        fromSlug: redirect.from_slug,
        targetRouteBase: table.route_base,
        targetSlug: version.slug,
      }
    }
    return null
  },
})

/**
 * Every published, non-deleted data row (excluding the `pages` table) with its
 * active version's slug and its table's route info — for the full-publish bake.
 */
export const listPublishedRowRoutes = query({
  args: {},
  returns: v.array(
    v.object({
      rowId: v.string(),
      rowSlug: v.string(),
      tableSlug: v.string(),
      tableRouteBase: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const rows = await ctx.db.query('data_rows').collect()
    const published = rows
      .filter(
        (row) =>
          row.table_id !== 'pages' &&
          row.status === 'published' &&
          row.deleted_at === null,
      )
      .sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      )

    const out: Array<{
      rowId: string
      rowSlug: string
      tableSlug: string
      tableRouteBase: string
    }> = []
    for (const row of published) {
      if (!row.active_version_id) continue
      const table = await tableByAppId(ctx, row.table_id)
      if (!table || table.deleted_at !== null) continue
      const version = await versionByAppId(ctx, row.active_version_id)
      if (!version) continue
      out.push({
        rowId: row.id,
        rowSlug: version.slug,
        tableSlug: table.slug,
        tableRouteBase: table.route_base,
      })
    }
    return out
  },
})

// ---------------------------------------------------------------------------
// Row-table route info
// ---------------------------------------------------------------------------

/** Route base + table slug for a non-deleted row in a non-deleted table. */
export const rowTableRouteInfo = query({
  args: { rowId: v.string() },
  returns: v.union(v.null(), v.object({ routeBase: v.string(), tableSlug: v.string() })),
  handler: async (ctx, { rowId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row || row.deleted_at !== null) return null
    const table = await tableByAppId(ctx, row.table_id)
    if (!table || table.deleted_at !== null) return null
    return { routeBase: table.route_base, tableSlug: table.slug }
  },
})

/** The owning table's raw route base for a row, ignoring soft deletes. */
export const rowTableRouteBase = query({
  args: { rowId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { rowId }) => {
    const row = await rowByAppId(ctx, rowId)
    if (!row) return null
    const table = await tableByAppId(ctx, row.table_id)
    return table?.route_base ?? null
  },
})

// ---------------------------------------------------------------------------
// Redirect CRUD (bundle export / import)
// ---------------------------------------------------------------------------

const exportableRedirectValidator = v.object({
  id: v.string(),
  tableId: v.string(),
  fromRouteBase: v.string(),
  fromSlug: v.string(),
  targetRowId: v.string(),
})

/** Every redirect, raw, ordered by source path — for a full-site export. */
export const listExportableRedirects = query({
  args: {},
  returns: v.array(exportableRedirectValidator),
  handler: async (ctx) => {
    const redirects = await ctx.db.query('data_row_redirects').collect()
    return redirects
      .sort((a, b) => {
        if (a.from_route_base !== b.from_route_base) {
          return a.from_route_base < b.from_route_base ? -1 : 1
        }
        if (a.from_slug !== b.from_slug) return a.from_slug < b.from_slug ? -1 : 1
        return 0
      })
      .map((row) => ({
        id: row.id,
        tableId: row.table_id,
        fromRouteBase: row.from_route_base,
        fromSlug: row.from_slug,
        targetRowId: row.target_row_id,
      }))
  },
})

/** Wipe all redirects — the `replace` import strategy before reinsert. */
export const deleteAllRedirects = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const redirects = await ctx.db.query('data_row_redirects').collect()
    for (const redirect of redirects) await ctx.db.delete(redirect._id)
    return null
  },
})

/**
 * Insert a redirect preserving its original id, upserting on the unique
 * `(from_route_base, from_slug)` source key (§4.6 read-by-index → patch-or-insert).
 */
export const importRedirect = mutation({
  args: exportableRedirectValidator,
  returns: v.null(),
  handler: async (ctx, input) => {
    const existing = await ctx.db
      .query('data_row_redirects')
      .withIndex('by_source', (q) =>
        q.eq('from_route_base', input.fromRouteBase).eq('from_slug', input.fromSlug),
      )
      .first()
    if (existing) {
      await ctx.db.patch(existing._id, {
        table_id: input.tableId,
        target_row_id: input.targetRowId,
      })
    } else {
      await ctx.db.insert('data_row_redirects', {
        id: input.id,
        table_id: input.tableId,
        from_route_base: input.fromRouteBase,
        from_slug: input.fromSlug,
        target_row_id: input.targetRowId,
        created_at: new Date().toISOString(),
      })
    }
    return null
  },
})
