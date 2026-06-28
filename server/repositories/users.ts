/**
 * Users / identity repository.
 *
 * Convex port: the read/write bodies are now thin adapters over
 * `convex/users.ts` (docs/CONVEX-MIGRATION.md §2).
 *
 * What stays here, on the Bun side:
 * - **`rowToUser`** — the single hydration mapper. The Convex functions return
 *   a *joined row* (user + role + avatar `public_path`) shaped exactly like
 *   `JoinedUserRow`; `rowToUser` turns it into `AuthUser`. The still-SQL session
 *   lookup in `server/auth/sessions.ts` calls the same `rowToUser`, so there is
 *   one hydration path, and Node-only `computeGravatarHash` + the `@core`
 *   capability canon never have to run inside Convex's V8 runtime.
 * - **`USER_JOINED_COLUMNS`** — still consumed by the (un-ported) session lookup
 *   (`server/auth/sessions.ts`), kept until that domain is migrated.
 * - **`computeGravatarHash` / `toPublicUser`** — exported, also consumed by
 *   `server/handlers/cms/{dashboard/activity,auth}.ts`.
 * - **TOTP encryption** (`encryptTotpSecret`) — uses the server master key, so
 *   it runs here; the resulting AES-GCM bytes cross to Convex as base64.
 *
 * @see convex/users.ts          — the Convex query/mutation functions
 * @see server/auth/sessions.ts  — the (still-SQL) session lookup sharing rowToUser
 */
import { createHash } from 'node:crypto'
import { isoDateOrNull } from '@core/utils/isoDate'
import { normalizeCapabilities, type CoreCapability } from '../auth/capabilities'
import {
  normalizeStepUpAuthMode,
  normalizeStepUpWindowMinutes,
  type StepUpAuthMode,
  type StepUpWindowMinutes,
} from '../auth/stepUpPolicy'
import {
  encryptedTotpSecretFromParts,
  encryptTotpSecret,
  type EncryptedTotpSecret,
} from '../auth/totpSecrets'
import type { UserRow, UserStatus } from '../types'
import { Type, filterArray } from '@core/utils/typeboxHelpers'
import { api, getConvex } from '../convex/client'

interface UserRole {
  id: string
  slug: string
  name: string
  description: string
  isSystem: boolean
  capabilities: CoreCapability[]
}

interface CmsUser {
  id: string
  email: string
  displayName: string
  status: UserStatus
  role: UserRole
  capabilities: CoreCapability[]
  lastLoginAt: string | null
  failedLoginCount: number
  lockedUntil: string | null
  avatarMediaId: string | null
  passwordUpdatedAt: string | null
  mfaEnabled: boolean
  mfaEnabledAt: string | null
  mfaRecoveryCodesRemaining: number
  stepUpAuthMode: StepUpAuthMode
  stepUpWindowMinutes: StepUpWindowMinutes
  /** Public path of the uploaded avatar (resolved from media_assets), or null. */
  avatarUrl: string | null
  /** SHA-256 hex of the normalized email — drives the Gravatar fallback URL. */
  gravatarHash: string
  createdAt: string
  updatedAt: string
}

export interface AuthUser extends CmsUser {
  passwordHash: string
  encryptedMfaTotpSecret: EncryptedTotpSecret | null
  mfaRecoveryCodeHashes: string[]
}

export interface JoinedUserRow extends UserRow {
  role_slug: string
  role_name: string
  role_description: string
  role_is_system: boolean | number
  role_capabilities_json: unknown
  avatar_public_path: string | null
}

/**
 * The full user + role + avatar column list, defined exactly once. The session
 * lookup in `server/auth/sessions.ts` splices this into a SELECT so the user,
 * role, and avatar columns live in a single place. The users repository's reads
 * go through `convex/users.ts`, which returns the same `JoinedUserRow` shape —
 * the constant stays exported until the session domain is ported too.
 */
export const USER_JOINED_COLUMNS = `users.id,
       users.email,
       users.email_normalized,
       users.display_name,
       users.password_hash,
       users.status,
       users.role_id,
       users.last_login_at,
       users.failed_login_count,
       users.locked_until,
       users.avatar_media_id,
       users.password_updated_at,
       users.mfa_enabled,
       users.mfa_enabled_at,
       users.mfa_totp_secret_ciphertext,
       users.mfa_totp_secret_iv,
       users.mfa_totp_secret_key_fingerprint,
       users.mfa_recovery_code_hashes_json,
       users.step_up_auth_mode,
       users.step_up_window_minutes,
       users.created_at,
       users.updated_at,
       users.deleted_at,
       roles.slug as role_slug,
       roles.name as role_name,
       roles.description as role_description,
       roles.is_system as role_is_system,
       roles.capabilities_json as role_capabilities_json,
       media_assets.public_path as avatar_public_path`

/**
 * The joined row as it arrives from `convex/users.ts`: identical to
 * `JoinedUserRow` except the two MFA-secret blobs travel as base64 strings
 * (Convex stores them base64-encoded, §6) rather than `Uint8Array`s, and the
 * `*_json` columns are already parsed. `wireToJoinedRow` decodes the blobs back
 * to bytes so `rowToUser` sees exactly its `JoinedUserRow` contract.
 */
type ConvexUserRow = Omit<
  JoinedUserRow,
  'mfa_totp_secret_ciphertext' | 'mfa_totp_secret_iv'
> & {
  mfa_totp_secret_ciphertext: string | null
  mfa_totp_secret_iv: string | null
}

function decodeMfaSecret(value: string | null): Uint8Array | null {
  return value === null ? null : new Uint8Array(Buffer.from(value, 'base64'))
}

function wireToJoinedRow(row: ConvexUserRow): JoinedUserRow {
  return {
    ...row,
    mfa_totp_secret_ciphertext: decodeMfaSecret(row.mfa_totp_secret_ciphertext),
    mfa_totp_secret_iv: decodeMfaSecret(row.mfa_totp_secret_iv),
  }
}

function authUserFromWire(row: ConvexUserRow): AuthUser {
  return rowToUser(wireToJoinedRow(row))
}

function publicUserFromWire(row: ConvexUserRow): CmsUser {
  return toPublicUser(authUserFromWire(row))
}

const RecoveryCodeHashSchema = Type.String()

export class UserMutationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'UserMutationError'
    this.status = status
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * SHA-256 hex of the normalized email. Gravatar accepts both MD5 and SHA-256
 * hashes; we use SHA-256 because Node/Bun ship it natively and it's the modern
 * default. The hash is recomputed on every read — there's no value in caching
 * it (cheap to derive, always tracks `email` mutations).
 *
 * Exported because the dashboard activity feed builds compact actor records
 * straight from a joined `users` row and needs the same hash the rest of the
 * `users` repository hands back.
 */
export function computeGravatarHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex')
}

export function rowToUser(row: JoinedUserRow): AuthUser {
  const capabilities = normalizeCapabilities(row.role_capabilities_json)
  const mfaRecoveryCodeHashes = filterArray(
    RecoveryCodeHashSchema,
    row.mfa_recovery_code_hashes_json,
  )
  const role: UserRole = {
    id: row.role_id,
    slug: row.role_slug,
    name: row.role_name,
    description: row.role_description,
    isSystem: Boolean(row.role_is_system),
    capabilities,
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    role,
    capabilities,
    passwordHash: row.password_hash,
    lastLoginAt: isoDateOrNull(row.last_login_at),
    failedLoginCount: Number(row.failed_login_count ?? 0),
    lockedUntil: isoDateOrNull(row.locked_until),
    avatarMediaId: row.avatar_media_id ?? null,
    passwordUpdatedAt: isoDateOrNull(row.password_updated_at),
    mfaEnabled: Boolean(row.mfa_enabled),
    mfaEnabledAt: isoDateOrNull(row.mfa_enabled_at),
    encryptedMfaTotpSecret: encryptedTotpSecretFromParts(
      row.mfa_totp_secret_ciphertext,
      row.mfa_totp_secret_iv,
      row.mfa_totp_secret_key_fingerprint,
    ),
    mfaRecoveryCodeHashes,
    mfaRecoveryCodesRemaining: mfaRecoveryCodeHashes.length,
    stepUpAuthMode: normalizeStepUpAuthMode(row.step_up_auth_mode),
    stepUpWindowMinutes: normalizeStepUpWindowMinutes(row.step_up_window_minutes),
    avatarUrl: row.avatar_public_path ?? null,
    gravatarHash: computeGravatarHash(row.email),
    createdAt: isoDateOrNull(row.created_at)!,
    updatedAt: isoDateOrNull(row.updated_at)!,
  }
}

export function toPublicUser(user: AuthUser): CmsUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    role: user.role,
    capabilities: user.capabilities,
    lastLoginAt: user.lastLoginAt,
    failedLoginCount: user.failedLoginCount,
    lockedUntil: user.lockedUntil,
    avatarMediaId: user.avatarMediaId,
    passwordUpdatedAt: user.passwordUpdatedAt,
    mfaEnabled: user.mfaEnabled,
    mfaEnabledAt: user.mfaEnabledAt,
    mfaRecoveryCodesRemaining: user.mfaRecoveryCodesRemaining,
    stepUpAuthMode: user.stepUpAuthMode,
    stepUpWindowMinutes: user.stepUpWindowMinutes,
    avatarUrl: user.avatarUrl,
    gravatarHash: user.gravatarHash,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

export async function listUsers(): Promise<CmsUser[]> {
  const rows = await getConvex().query(api.users.list, {})
  return rows.map(publicUserFromWire)
}

export async function findUserById(userId: string): Promise<AuthUser | null> {
  const row = await getConvex().query(api.users.findById, { userId })
  return row ? authUserFromWire(row) : null
}

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const row = await getConvex().query(api.users.findByEmail, {
    emailNormalized: normalizeEmail(email),
  })
  return row ? authUserFromWire(row) : null
}

export async function createUser(
  input: {
    id?: string
    email: string
    displayName: string
    passwordHash: string
    roleId: string
    status?: UserStatus
    allowOwnerRole?: boolean
  },
): Promise<CmsUser> {
  const email = input.email.trim()
  const emailNormalized = normalizeEmail(email)
  if (!emailNormalized.includes('@')) throw new UserMutationError('Invalid email')
  const displayName = input.displayName.trim() || email
  const status = input.status ?? 'active'
  if (input.roleId === 'owner' && input.allowOwnerRole !== true) {
    throw new UserMutationError('Owner role is setup-only')
  }

  const row = await getConvex().mutation(api.users.create, {
    id: input.id,
    email,
    emailNormalized,
    displayName,
    passwordHash: input.passwordHash,
    status,
    roleId: input.roleId,
  })
  if (!row) throw new UserMutationError('User was not created', 500)
  return publicUserFromWire(row)
}

export async function updateUser(
  userId: string,
  input: {
    email?: string
    displayName?: string
    passwordHash?: string
    status?: UserStatus
    roleId?: string
  },
): Promise<CmsUser | null> {
  const current = await findUserById(userId)
  if (!current) return null

  const email = input.email === undefined ? current.email : input.email.trim()
  const emailNormalized = normalizeEmail(email)
  if (!emailNormalized.includes('@')) throw new UserMutationError('Invalid email')
  const displayName = input.displayName === undefined
    ? current.displayName
    : input.displayName.trim() || email
  const status = input.status ?? current.status
  const roleId = input.roleId ?? current.role.id
  const passwordHash = input.passwordHash ?? current.passwordHash
  const passwordUpdatedAt = input.passwordHash === undefined
    ? current.passwordUpdatedAt
    : new Date().toISOString()

  const row = await getConvex().mutation(api.users.update, {
    userId,
    email,
    emailNormalized,
    displayName,
    passwordHash,
    passwordUpdatedAt,
    status,
    roleId,
  })
  return row ? publicUserFromWire(row) : null
}

/**
 * Update only the avatar reference on a user row. Returns the post-update
 * public user view (with `avatarUrl` resolved via the join) or null when
 * the target row is missing/soft-deleted.
 */
export async function setUserAvatarMediaId(
  userId: string,
  mediaId: string | null,
): Promise<CmsUser | null> {
  const row = await getConvex().mutation(api.users.setAvatarMediaId, { userId, mediaId })
  return row ? publicUserFromWire(row) : null
}

export async function updateUserPasswordHash(
  userId: string,
  passwordHash: string,
): Promise<CmsUser | null> {
  const row = await getConvex().mutation(api.users.updatePasswordHash, {
    userId,
    passwordHash,
  })
  return row ? publicUserFromWire(row) : null
}

export async function enableUserTotpMfa(
  userId: string,
  input: {
    secret: string
    recoveryCodeHashes: string[]
  },
): Promise<CmsUser | null> {
  const encryptedSecret = await encryptTotpSecret(input.secret)
  const row = await getConvex().mutation(api.users.enableTotpMfa, {
    userId,
    ciphertext: Buffer.from(encryptedSecret.ciphertext).toString('base64'),
    iv: Buffer.from(encryptedSecret.iv).toString('base64'),
    keyFingerprint: encryptedSecret.keyFingerprint,
    recoveryCodeHashes: input.recoveryCodeHashes,
  })
  return row ? publicUserFromWire(row) : null
}

export async function disableUserTotpMfa(
  userId: string,
): Promise<CmsUser | null> {
  const row = await getConvex().mutation(api.users.disableTotpMfa, { userId })
  return row ? publicUserFromWire(row) : null
}

export async function replaceUserRecoveryCodeHashes(
  userId: string,
  recoveryCodeHashes: string[],
): Promise<CmsUser | null> {
  const row = await getConvex().mutation(api.users.replaceRecoveryCodeHashes, {
    userId,
    recoveryCodeHashes,
  })
  return row ? publicUserFromWire(row) : null
}

export async function updateUserStepUpPolicy(
  userId: string,
  input: {
    mode: StepUpAuthMode
    windowMinutes: StepUpWindowMinutes
  },
): Promise<CmsUser | null> {
  const row = await getConvex().mutation(api.users.updateStepUpPolicy, {
    userId,
    mode: input.mode,
    windowMinutes: input.windowMinutes,
  })
  return row ? publicUserFromWire(row) : null
}

export async function consumeUserRecoveryCodeHash(
  userId: string,
  usedHash: string,
): Promise<boolean> {
  return getConvex().mutation(api.users.consumeRecoveryCodeHash, { userId, usedHash })
}

export async function softDeleteUser(userId: string): Promise<boolean> {
  return getConvex().mutation(api.users.softDelete, { userId })
}

export async function countActiveOwners(): Promise<number> {
  return getConvex().query(api.users.countActiveOwners, {})
}

export async function markUserLoggedIn(userId: string): Promise<void> {
  await getConvex().mutation(api.users.markLoggedIn, { userId })
}

/**
 * Increment the user's failed-login counter and (if a lockout was triggered)
 * persist the new `locked_until` deadline. Returns the post-update user row so
 * the caller can decide whether to emit a lock audit event.
 *
 * Idempotent in the sense that it always runs an UPDATE; the caller is
 * responsible for not double-counting (one call per failed attempt).
 */
export async function recordFailedLoginAttempt(
  userId: string,
  lockedUntil: Date | null,
): Promise<{ failedLoginCount: number; lockedUntil: string | null } | null> {
  return getConvex().mutation(api.users.recordFailedLoginAttempt, {
    userId,
    lockedUntil: lockedUntil === null ? null : lockedUntil.toISOString(),
  })
}
