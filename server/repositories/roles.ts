/**
 * Roles registry.
 *
 * The four built-in system roles (owner, admin, client, member) plus any
 * operator-created custom roles. Roles carry a capability grant list; the admin
 * UI manages them through the `roles.manage` capability.
 *
 * Convex port: this file is now a thin adapter over `convex/roles.ts` (see
 * docs/CONVEX-MIGRATION.md §2). The bodies read/write through the shared
 * `getConvex()` handle.
 *
 * Two concerns stay on the server side of the boundary, because they depend on
 * server-only constants that cannot be bundled into Convex:
 *  - capability normalization (`normalizeCapabilities` filters/sorts against
 *    `CORE_CAPABILITIES`) is applied to every returned role here;
 *  - the rank ordering (`compareRolesByRank` uses `SYSTEM_ROLES` order) is the
 *    final sort of `listRoles`.
 *  - `syncSystemRoles` builds its payload from the code-declared `SYSTEM_ROLES`
 *    / `FORCE_SYNC_ROLE_IDS` and hands it to one atomic Convex mutation.
 *
 * Domain validity failures thrown inside the Convex mutations arrive as a
 * `ConvexError` carrying `{ message, status }`; we re-raise them as the
 * `RoleMutationError` the HTTP layer (`mutationErrorResponse`) already expects.
 *
 * @see convex/roles.ts            — the Convex query/mutation functions
 * @see server/handlers/cms/roles.ts — the endpoints that consume this
 */

import { ConvexError } from 'convex/values'
import {
  FORCE_SYNC_ROLE_IDS,
  normalizeCapabilities,
  SYSTEM_ROLES,
  type CoreCapability,
} from '../auth/capabilities'
import { api, getConvex } from '../convex/client'

interface Role {
  id: string
  slug: string
  name: string
  description: string
  isSystem: boolean
  capabilities: CoreCapability[]
  createdAt: string
  updatedAt: string
}

/** The camelCase role shape returned by `convex/roles.ts`, before the
 *  server-side capability normalization this adapter applies. */
interface ConvexRole {
  id: string
  slug: string
  name: string
  description: string
  isSystem: boolean
  capabilities: string[]
  createdAt: string
  updatedAt: string
}

export class RoleMutationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RoleMutationError'
    this.status = status
  }
}

function toRole(role: ConvexRole): Role {
  return {
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    capabilities: normalizeCapabilities(role.capabilities),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  }
}

/** Re-raise a Convex-thrown domain error as the typed `RoleMutationError` the
 *  HTTP layer maps to a status code; pass anything else through untouched. */
function rethrowRoleError(err: unknown): never {
  if (err instanceof ConvexError) {
    const data = err.data as { message?: string; status?: number }
    throw new RoleMutationError(data?.message ?? 'Role mutation failed', data?.status ?? 400)
  }
  throw err
}

const SYSTEM_ROLE_RANK = new Map(SYSTEM_ROLES.map((role, index) => [role.id, index]))
const CUSTOM_ROLE_RANK = SYSTEM_ROLES.length

function compareRolesByRank(a: Role, b: Role): number {
  const rankDifference =
    (SYSTEM_ROLE_RANK.get(a.id) ?? CUSTOM_ROLE_RANK) -
    (SYSTEM_ROLE_RANK.get(b.id) ?? CUSTOM_ROLE_RANK)
  if (rankDifference !== 0) return rankDifference
  return a.name.localeCompare(b.name)
}

export async function listRoles(): Promise<Role[]> {
  const roles = await getConvex().query(api.roles.list, {})
  return roles.map(toRole).sort(compareRolesByRank)
}

export async function createCustomRole(
  input: {
    name: string
    slug?: string
    description: string
    capabilities: CoreCapability[]
  },
): Promise<Role> {
  try {
    const role = await getConvex().mutation(api.roles.createCustom, {
      name: input.name,
      slugInput: input.slug ?? null,
      description: input.description,
      capabilities: input.capabilities,
    })
    return toRole(role)
  } catch (err) {
    rethrowRoleError(err)
  }
}

/**
 * Update an existing role. Built-in (system) roles other than Owner are
 * editable just like custom roles — only the Owner is locked.
 *
 * Owner-role policy:
 *  - capabilities are managed by the system (synced from `CORE_CAPABILITIES`
 *    at boot via `syncSystemRoles`) and cannot be edited
 *  - the row itself cannot be renamed or re-described — its presence is a
 *    structural invariant of the installation
 */
export async function updateRole(
  roleId: string,
  input: {
    name?: string
    slug?: string
    description?: string
    capabilities?: CoreCapability[]
  },
): Promise<Role | null> {
  try {
    const role = await getConvex().mutation(api.roles.update, {
      roleId,
      name: input.name,
      slug: input.slug,
      description: input.description,
      capabilities: input.capabilities,
    })
    return role ? toRole(role) : null
  } catch (err) {
    rethrowRoleError(err)
  }
}

/**
 * Delete a custom role. System roles (built-ins) cannot be deleted — they
 * are part of the installation's expected role registry. Use `updateRole`
 * to edit a non-owner system role's name/capabilities instead.
 */
export async function deleteCustomRole(roleId: string): Promise<Role | null> {
  try {
    const role = await getConvex().mutation(api.roles.deleteCustom, { roleId })
    return role ? toRole(role) : null
  } catch (err) {
    rethrowRoleError(err)
  }
}

/**
 * Boot-time sync — UPSERT every entry from `SYSTEM_ROLES` so the four built-in
 * roles (owner, admin, client, member) always exist after a fresh install OR
 * an upgrade that introduces a new system role.
 *
 *  - Roles in `FORCE_SYNC_ROLE_IDS` (Owner + Admin) — name / description /
 *    capabilities are ALWAYS resynced from the code constants. Adding a new
 *    capability to `CORE_CAPABILITIES` and to the role's literal list in
 *    `SYSTEM_ROLES` propagates to every existing installation on the next
 *    boot — owners and admins are never stranded on a stale grant list, and
 *    operators don't have to manually re-grant new capabilities through the
 *    admin UI after every upgrade.
 *  - Client / Member: inserted on first boot only. Subsequent boots leave
 *    the persisted row untouched so user-customised name / description /
 *    capabilities survive upgrades. Use the admin UI to edit them.
 *
 * The trade-off for Admin force-sync: if an operator hand-removes a
 * capability from the Admin role through the UI, the boot sync restores
 * it. That is intentional — capability grants for built-in roles are a
 * code-level decision, not a runtime one. Operators who need a "limited
 * admin" persona should create a custom role.
 *
 * Called from `server/index.ts` at boot.
 */
export async function syncSystemRoles(): Promise<void> {
  await getConvex().mutation(api.roles.sync, {
    roles: SYSTEM_ROLES.map((role) => ({
      id: role.id,
      slug: role.slug,
      name: role.name,
      description: role.description,
      capabilities: role.capabilities,
      forceSync: FORCE_SYNC_ROLE_IDS.includes(role.id),
    })),
  })
}
