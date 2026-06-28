/**
 * Media folders — Convex functions.
 *
 * The Convex half of the `media_folders` domain; the thin repository adapter
 * (`server/repositories/mediaFolders.ts`) marshals args into these and maps the
 * rows back through its pure `mapFolder` hydrator. Folders form a tree via
 * `parent_id` (null = root); slugs are unique within a parent.
 *
 * Convex specifics (docs/CONVEX-MIGRATION.md §4):
 * - **No `ON CONFLICT`** → `importFolder` is a read-by-app-id → patch-or-insert
 *   (§4.6).
 * - **No partial-unique index** → `isSlugTaken` re-expresses the
 *   `media_folders_parent_slug_idx` uniqueness as an explicit index read; the
 *   create/rename handlers call it before writing.
 * - **No cascade delete** → `del` deletes the whole `parent_id` subtree AND the
 *   `media_asset_folders` membership rows of every deleted folder by hand (the
 *   SQL `ON DELETE CASCADE` on both `parent_id` and `folder_id`). `deleteAll`
 *   wipes every folder + every membership.
 * - **COALESCE-keep update** → `update` reads the row and applies
 *   `arg ?? existing`. `parent_id` distinguishes "not provided" (absent →
 *   `undefined`) from "move to root" (explicit `null`).
 *
 * Every function declares both `args` AND `returns` validators.
 *
 * @see server/repositories/mediaFolders.ts — the thin repository adapter
 */

import { v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

/** The raw `media_folders` projection consumed by the repository's `mapFolder`. */
const folderRowValidator = v.object({
  id: v.string(),
  parent_id: v.union(v.null(), v.string()),
  name: v.string(),
  slug: v.string(),
  sort_order: v.number(),
  created_by_user_id: v.union(v.null(), v.string()),
  created_at: v.string(),
})

function folderByAppId(ctx: QueryCtx | MutationCtx, id: string) {
  return ctx.db
    .query('media_folders')
    .withIndex('by_app_id', (q) => q.eq('id', id))
    .unique()
}

function toRow(doc: Doc<'media_folders'>) {
  return {
    id: doc.id,
    parent_id: doc.parent_id,
    name: doc.name,
    slug: doc.slug,
    sort_order: doc.sort_order,
    created_by_user_id: doc.created_by_user_id,
    created_at: doc.created_at,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every folder, ordered `sort_order asc, lower(name) asc` (the SQL list order). */
export const list = query({
  args: {},
  returns: v.array(folderRowValidator),
  handler: async (ctx) => {
    const all = await ctx.db.query('media_folders').collect()
    return all
      .sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        const an = a.name.toLowerCase()
        const bn = b.name.toLowerCase()
        return an < bn ? -1 : an > bn ? 1 : 0
      })
      .map(toRow)
  },
})

/** A single folder by app id, or `null`. */
export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), folderRowValidator),
  handler: async (ctx, { id }) => {
    const doc = await folderByAppId(ctx, id)
    return doc ? toRow(doc) : null
  },
})

/**
 * Whether `(parentId, slug)` is already taken (optionally excluding one id) —
 * the explicit re-expression of the partial-unique `media_folders_parent_slug_idx`.
 */
export const isSlugTaken = query({
  args: {
    parentId: v.union(v.null(), v.string()),
    slug: v.string(),
    excludeId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, { parentId, slug, excludeId }) => {
    const candidates = await ctx.db
      .query('media_folders')
      .withIndex('by_parent_slug', (q) => q.eq('parent_id', parentId).eq('slug', slug))
      .collect()
    return candidates.some((r) => (excludeId ? r.id !== excludeId : true))
  },
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Insert a folder; `created_at` is stamped here. */
export const create = mutation({
  args: {
    id: v.string(),
    parentId: v.union(v.null(), v.string()),
    name: v.string(),
    slug: v.string(),
    sortOrder: v.number(),
    createdByUserId: v.union(v.null(), v.string()),
  },
  returns: folderRowValidator,
  handler: async (ctx, args) => {
    const docId = await ctx.db.insert('media_folders', {
      id: args.id,
      parent_id: args.parentId,
      name: args.name,
      slug: args.slug,
      sort_order: args.sortOrder,
      created_by_user_id: args.createdByUserId,
      created_at: new Date().toISOString(),
    })
    const fresh = await ctx.db.get(docId)
    return toRow(fresh!)
  },
})

/**
 * COALESCE-keep update. `name`/`slug`/`sortOrder` absent → keep existing.
 * `parentId` absent (`undefined`) → don't touch; explicit `null` → move to root.
 * Returns the updated row, or `null` if the folder is gone.
 */
export const update = mutation({
  args: {
    id: v.string(),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    sortOrder: v.optional(v.number()),
    parentId: v.optional(v.union(v.null(), v.string())),
  },
  returns: v.union(v.null(), folderRowValidator),
  handler: async (ctx, args) => {
    const doc = await folderByAppId(ctx, args.id)
    if (!doc) return null
    await ctx.db.patch(doc._id, {
      name: args.name ?? doc.name,
      slug: args.slug ?? doc.slug,
      sort_order: args.sortOrder ?? doc.sort_order,
      parent_id: args.parentId === undefined ? doc.parent_id : args.parentId,
    })
    const fresh = await ctx.db.get(doc._id)
    return toRow(fresh!)
  },
})

/**
 * Delete a folder and its whole `parent_id` subtree (the SQL `ON DELETE CASCADE`
 * on `media_folders.parent_id` is recursive), plus the `media_asset_folders`
 * membership rows of every deleted folder. Assets themselves stay (they become
 * Uncategorized). Returns `true` when the target folder existed.
 */
export const del = mutation({
  args: { id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { id }) => {
    const target = await folderByAppId(ctx, id)
    if (!target) return false

    // Collect the subtree (BFS over the by_parent index).
    const toDelete: Array<Doc<'media_folders'>> = [target]
    const queue: string[] = [id]
    while (queue.length > 0) {
      const parentId = queue.shift() as string
      const children = await ctx.db
        .query('media_folders')
        .withIndex('by_parent', (q) => q.eq('parent_id', parentId))
        .collect()
      for (const child of children) {
        toDelete.push(child)
        queue.push(child.id)
      }
    }

    for (const folder of toDelete) {
      const memberships = await ctx.db
        .query('media_asset_folders')
        .withIndex('by_folder', (q) => q.eq('folder_id', folder.id))
        .collect()
      for (const m of memberships) await ctx.db.delete(m._id)
      await ctx.db.delete(folder._id)
    }
    return true
  },
})

/** Wipe every folder and every membership — the `replace` import strategy. */
export const deleteAll = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const memberships = await ctx.db.query('media_asset_folders').collect()
    for (const m of memberships) await ctx.db.delete(m._id)
    const folders = await ctx.db.query('media_folders').collect()
    for (const f of folders) await ctx.db.delete(f._id)
    return null
  },
})

/**
 * Id-preserving folder upsert for bundle import (§4.6 read-by-app-id →
 * patch-or-insert). `created_by_user_id` is left null — folder authorship is
 * instance-local and not carried in the bundle.
 */
export const importFolder = mutation({
  args: {
    id: v.string(),
    parentId: v.union(v.null(), v.string()),
    name: v.string(),
    slug: v.string(),
    sortOrder: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await folderByAppId(ctx, args.id)
    if (existing) {
      await ctx.db.patch(existing._id, {
        parent_id: args.parentId,
        name: args.name,
        slug: args.slug,
        sort_order: args.sortOrder,
      })
    } else {
      await ctx.db.insert('media_folders', {
        id: args.id,
        parent_id: args.parentId,
        name: args.name,
        slug: args.slug,
        sort_order: args.sortOrder,
        created_by_user_id: null,
        created_at: new Date().toISOString(),
      })
    }
    return null
  },
})
