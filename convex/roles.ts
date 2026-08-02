/**
 * Roles registry — Convex functions.
 *
 * The Convex half of the `roles` domain; the thin repository adapter
 * (`server/repositories/roles.ts`) marshals args into these, normalizes the
 * returned capability lists against `CORE_CAPABILITIES`, and rank-sorts the
 * list. All persistence, id/timestamp generation, slug derivation, and the
 * validity branches live here (see docs/CONVEX-MIGRATION.md §2, §3, §4.6).
 *
 * Conventions this slice follows:
 * - App identity is the nanoid `id`, but system roles use their well-known
 *   literal ids (`owner`/`admin`/`client`/`member`) supplied by the caller;
 *   only `createCustom` generates a fresh nanoid here. Convex `_id` never leaks.
 * - `created_at` / `updated_at` (SQL column defaults) are generated here.
 * - `capabilities_json` is an opaque JSON string column; we parse it on read
 *   and stringify on write. The repository re-normalizes the parsed array
 *   against `CORE_CAPABILITIES` (that constant is server-side, so it stays out
 *   of Convex).
 * - Domain validity failures throw a `ConvexError` carrying `{ message, status }`
 *   so the repository can re-raise the existing `RoleMutationError(message,
 *   status)` and the HTTP layer keeps its status codes.
 * - Every function declares `args` AND `returns` validators.
 */

import { ConvexError, v } from 'convex/values'
import { nanoid } from 'nanoid'
import { mutation, query } from './_generated/server'
import type { Doc } from './_generated/dataModel'

// The Owner role id is a structural installation invariant; mirrors
// `OWNER_ROLE_ID` in server/auth/capabilities.ts (server constants cannot be
// imported into the Convex bundle).
const OWNER_ROLE_ID = 'owner'

/** The camelCase shape every read returns — matches the repository's `Role`
 *  (minus the final capability normalization, which the repo applies). */
const roleValidator = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  description: v.string(),
  isSystem: v.boolean(),
  capabilities: v.array(v.string()),
  createdAt: v.string(),
  updatedAt: v.string(),
})

function fail(message: string, status: number): never {
  throw new ConvexError({ message, status })
}

function slugFromRoleName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function toRoleResult(doc: Doc<'roles'>) {
  return {
    id: doc.id,
    slug: doc.slug,
    name: doc.name,
    description: doc.description,
    isSystem: doc.is_system,
    // Opaque JSON blob, parsed here; the repository re-normalizes against
    // CORE_CAPABILITIES. Always written as a JSON array, so parse is safe.
    capabilities: JSON.parse(doc.capabilities_json) as string[],
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  }
}

/** Every role, unordered — the repository applies the rank sort. */
export const list = query({
  args: {},
  returns: v.array(roleValidator),
  handler: async (ctx) => {
    const rows = await ctx.db.query('roles').collect()
    return rows.map(toRoleResult)
  },
})

/**
 * Create a custom (non-system) role. Generates the app `id` and timestamps.
 * Re-implements the SQL slug derivation + the `assertRoleSlugAvailable`
 * uniqueness guard atomically (read-by-index → insert).
 */
export const createCustom = mutation({
  args: {
    name: v.string(),
    slugInput: v.union(v.null(), v.string()),
    description: v.string(),
    capabilities: v.array(v.string()),
  },
  returns: roleValidator,
  handler: async (ctx, args) => {
    const name = args.name.trim()
    if (!name) fail('Role name is required', 400)

    const slug = slugFromRoleName(args.slugInput || name)
    if (!slug) fail('Role slug is required', 400)

    const existing = await ctx.db
      .query('roles')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .first()
    if (existing) fail('Role slug is already in use', 409)

    const now = new Date().toISOString()
    const id = nanoid()
    const doc = {
      id,
      slug,
      name,
      description: args.description.trim(),
      is_system: false,
      capabilities_json: JSON.stringify(args.capabilities),
      created_at: now,
      updated_at: now,
    }
    await ctx.db.insert('roles', doc)
    return {
      id,
      slug,
      name,
      description: doc.description,
      isSystem: false,
      capabilities: args.capabilities,
      createdAt: now,
      updatedAt: now,
    }
  },
})

/**
 * Update an existing role. Built-in roles other than Owner are editable like
 * custom roles — only the Owner row is locked. Returns `null` if the role does
 * not exist (the repository surfaces a 404). Replicates the SQL read-current →
 * branch → slug-availability → update sequence in one atomic mutation.
 */
export const update = mutation({
  args: {
    roleId: v.string(),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    description: v.optional(v.string()),
    capabilities: v.optional(v.array(v.string())),
  },
  returns: v.union(v.null(), roleValidator),
  handler: async (ctx, args) => {
    // App-id lookup is a scan: the schema's `by_id` index name collides with
    // Convex's reserved system index over `_id`, so it cannot serve the app
    // `id` string column. The roles table is tiny (a handful of rows), so the
    // O(N) scan is the sanctioned fallback (docs/CONVEX-MIGRATION.md §4.4).
    const current = (await ctx.db.query('roles').collect()).find((r) => r.id === args.roleId)
    if (!current) return null
    if (current.id === OWNER_ROLE_ID) {
      fail('The Owner role is locked and cannot be edited', 409)
    }

    const name = args.name === undefined ? current.name : args.name.trim()
    if (!name) fail('Role name is required', 400)
    const slug = args.slug === undefined ? current.slug : slugFromRoleName(args.slug)
    if (!slug) fail('Role slug is required', 400)

    const conflict = await ctx.db
      .query('roles')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .first()
    if (conflict && conflict.id !== current.id) {
      fail('Role slug is already in use', 409)
    }

    const description =
      args.description === undefined ? current.description : args.description.trim()
    const capabilities_json =
      args.capabilities === undefined
        ? current.capabilities_json
        : JSON.stringify(args.capabilities)
    const now = new Date().toISOString()

    await ctx.db.patch(current._id, {
      slug,
      name,
      description,
      capabilities_json,
      updated_at: now,
    })
    return toRoleResult({
      ...current,
      slug,
      name,
      description,
      capabilities_json,
      updated_at: now,
    })
  },
})

/**
 * Delete a custom role. System roles cannot be deleted, nor can a role still
 * assigned to a live (non-deleted) user. Returns `null` if not found.
 */
export const deleteCustom = mutation({
  args: { roleId: v.string() },
  returns: v.union(v.null(), roleValidator),
  handler: async (ctx, { roleId }) => {
    // Scan for the app `id` — see the note in `update` (reserved `by_id`).
    const current = (await ctx.db.query('roles').collect()).find((r) => r.id === roleId)
    if (!current) return null
    if (current.is_system) fail('System roles cannot be deleted', 409)

    const assigned = await ctx.db
      .query('users')
      .withIndex('by_role_id', (q) => q.eq('role_id', roleId))
      .collect()
    const liveCount = assigned.filter((u) => u.deleted_at === null).length
    if (liveCount > 0) fail('Cannot delete a role assigned to users', 409)

    const result = toRoleResult(current)
    await ctx.db.delete(current._id)
    return result
  },
})

/**
 * Boot-time idempotent sync of the built-in roles. The caller supplies the
 * code-declared `SYSTEM_ROLES` (with `forceSync` precomputed from
 * `FORCE_SYNC_ROLE_IDS`) because those are server constants. Per role:
 *  - `forceSync` (Owner / Admin): upsert, always resetting name / description /
 *    capabilities to the code values.
 *  - otherwise (Client / Member): insert on first boot only; an existing row is
 *    left untouched so operator customisation survives upgrades.
 * One atomic mutation over all roles.
 */
export const sync = mutation({
  args: {
    roles: v.array(
      v.object({
        id: v.string(),
        slug: v.string(),
        name: v.string(),
        description: v.string(),
        capabilities: v.array(v.string()),
        forceSync: v.boolean(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { roles }) => {
    const now = new Date().toISOString()
    // One scan into an id→doc map; `by_id` is reserved (see `update`), and this
    // avoids re-scanning per role.
    const existingById = new Map(
      (await ctx.db.query('roles').collect()).map((r) => [r.id, r]),
    )
    for (const role of roles) {
      const existing = existingById.get(role.id)
      const capabilities_json = JSON.stringify(role.capabilities)
      if (existing) {
        if (role.forceSync) {
          await ctx.db.patch(existing._id, {
            slug: role.slug,
            name: role.name,
            description: role.description,
            is_system: true,
            capabilities_json,
            updated_at: now,
          })
        }
        // Non-force roles: leave the persisted row untouched (SQL `do nothing`).
      } else {
        await ctx.db.insert('roles', {
          id: role.id,
          slug: role.slug,
          name: role.name,
          description: role.description,
          is_system: true,
          capabilities_json,
          created_at: now,
          updated_at: now,
        })
      }
    }
    return null
  },
})
