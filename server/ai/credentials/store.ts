/**
 * AI provider credential repository — CRUD over `ai_provider_credentials`.
 *
 * Owns:
 *   - All SQL touching the credentials table.
 *   - Encryption on write + decryption on read.
 *   - The boundary between DB row shape (Uint8Array bytea/blob) and the
 *     server-side `CredentialRecord` (typed bytes).
 *   - The wire-safe `CredentialView` projection — `toCredentialView()` is
 *     the ONLY way to expose a credential outside this module.
 *
 * Does NOT own:
 *   - HTTP semantics (handlers parse bodies + call these functions).
 *   - Capability gating (handlers call `requireCapability` first).
 *   - Cross-user reads (every query filters by `user_id` — defence in depth).
 *
 * Gated by `ai-credentials-never-leak.test.ts` (Phase 1).
 */

import type { DbClient } from '../../db/client'
import { api, getConvex } from '../../convex/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from '../../secrets/encryption'
import {
  getMasterKeyFingerprint,
  loadMasterKey,
  MasterKeyConfigurationError,
} from '../../secrets/masterKey'
import type {
  CreateCredentialInput,
  CredentialRecord,
  CredentialView,
  UpdateCredentialInput,
} from './types'
import type { AiAuthMode, AiProviderId } from '../runtime/types'
import type { AiResolvedCredential } from '../drivers/types'

// ---------------------------------------------------------------------------
// Row shape ↔ record shape
// ---------------------------------------------------------------------------

interface CredentialRow {
  id: string
  user_id: string
  provider_id: string
  auth_mode: string
  display_label: string
  ciphertext: Uint8Array | null
  iv: Uint8Array | null
  base_url: string | null
  key_fingerprint: string | null
  created_at: Date | string
  updated_at: Date | string
  last_used_at: Date | string | null
}

function rowToRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id as AiProviderId,
    authMode: row.auth_mode as AiAuthMode,
    displayLabel: row.display_label,
    ciphertext: row.ciphertext,
    iv: row.iv,
    baseUrl: row.base_url,
    keyFingerprint: row.key_fingerprint,
    createdAt: isoDateOrNull(row.created_at)!,
    updatedAt: isoDateOrNull(row.updated_at)!,
    lastUsedAt: isoDateOrNull(row.last_used_at),
  }
}

/**
 * The credential row as it arrives from `convex/aiCredentials.ts`: identical to
 * `CredentialRow` except the AES-GCM `ciphertext` / `iv` blobs travel as base64
 * strings (Convex stores them base64-encoded, §6) rather than `Uint8Array`s.
 * The master key never reaches the Convex V8 runtime — all crypto stays here.
 */
type ConvexCredentialRow = Omit<CredentialRow, 'ciphertext' | 'iv'> & {
  ciphertext: string | null
  iv: string | null
}

function decodeBytes(value: string | null): Uint8Array | null {
  return value === null ? null : new Uint8Array(Buffer.from(value, 'base64'))
}

function encodeBytes(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString('base64')
}

function wireToRecord(row: ConvexCredentialRow): CredentialRecord {
  return rowToRecord({
    ...row,
    ciphertext: decodeBytes(row.ciphertext),
    iv: decodeBytes(row.iv),
  })
}

/**
 * Project a CredentialRecord to its wire-safe view. This function — and only
 * this function — is allowed to cross the HTTP boundary with credential
 * data. The `ai-credentials-never-leak.test.ts` gate scans handlers to
 * ensure no other shape escapes.
 */
export async function toCredentialView(
  record: CredentialRecord,
): Promise<CredentialView> {
  const currentFingerprint = record.keyFingerprint
    ? await getMasterKeyFingerprint()
    : null
  return {
    id: record.id,
    providerId: record.providerId,
    authMode: record.authMode,
    displayLabel: record.displayLabel,
    baseUrl: record.baseUrl,
    keyFingerprintCurrent:
      record.keyFingerprint === null
        ? true
        : record.keyFingerprint === currentFingerprint,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CredentialError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CredentialError'
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * List every credential owned by `userId`, newest first. Returns records
 * (not views) — the handler projects to views via `toCredentialView()`.
 *
 * The query restricts `auth_mode` to the currently-supported set so a
 * stale dev row carrying a retired value never reaches the wire and
 * breaks the JSON-schema parse on the client.
 */
export async function listCredentialsForUser(
  _db: DbClient,
  userId: string,
): Promise<CredentialRecord[]> {
  const rows = await getConvex().query(api.aiCredentials.listForUser, { userId })
  return rows.map(wireToRecord)
}

/**
 * Read a single credential, with the `user_id` predicate as a cross-user
 * guard. Returns null when the row doesn't exist OR belongs to another
 * user — handlers should treat both as 404.
 */
export async function readCredentialForUser(
  _db: DbClient,
  userId: string,
  credentialId: string,
): Promise<CredentialRecord | null> {
  const row = await getConvex().query(api.aiCredentials.readForUser, {
    userId,
    credentialId,
  })
  return row ? wireToRecord(row) : null
}

/**
 * Decrypt a credential into a driver-callable `AiResolvedCredential`. The
 * returned object holds the plaintext key in memory for the duration of the
 * caller's frame — callers MUST scope it to a single driver invocation.
 *
 * Throws if:
 *   - The key's fingerprint doesn't match the live master key
 *     (rotation needed — UI shows "re-enter your key").
 *   - Decryption fails (tampering or corrupted ciphertext).
 *   - The auth_mode + shape are inconsistent (data corruption).
 */
export async function resolveCredentialForDriver(
  record: CredentialRecord,
): Promise<AiResolvedCredential> {
  const currentFingerprint = await getMasterKeyFingerprint()
  if (record.keyFingerprint && record.keyFingerprint !== currentFingerprint) {
    throw new CredentialError(
      `Credential ${record.id} was encrypted with a different master key. ` +
      `Re-enter the API key in /admin/ai/providers.`,
      409,
    )
  }

  let apiKey: string | null = null
  if (record.ciphertext && record.iv) {
    const masterKey = await loadMasterKey()
    apiKey = await decryptSecret(masterKey, {
      ciphertext: record.ciphertext,
      iv: record.iv,
    })
  }

  if (record.authMode === 'apiKey' && !apiKey) {
    throw new CredentialError(
      `Credential ${record.id} is marked auth_mode='apiKey' but has no ` +
      `stored key — data corruption. Re-enter the key in /admin/ai/providers.`,
      500,
    )
  }

  if (record.authMode === 'baseUrl' && !record.baseUrl) {
    throw new CredentialError(
      `Credential ${record.id} is marked auth_mode='baseUrl' but has no ` +
      `stored URL — data corruption. Re-enter the URL in /admin/ai/providers.`,
      500,
    )
  }

  return {
    id: record.id,
    providerId: record.providerId,
    authMode: record.authMode,
    apiKey,
    baseUrl: record.baseUrl,
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Insert a new credential row. Encrypts any recoverable secret material with
 * the live master key + stores the key fingerprint so the UI can later detect
 * rotation.
 *
 * Throws CredentialError on:
 *   - duplicate (user_id, provider_id, display_label) — surfaced as 409
 *   - missing key for 'apiKey' mode — surfaced as 400
 *   - missing url for 'baseUrl' mode — surfaced as 400
 */
export async function createCredentialForUser(
  _db: DbClient,
  userId: string,
  input: CreateCredentialInput,
): Promise<CredentialRecord> {
  let encrypted: EncryptedSecret | null
  let fingerprint: string | null
  try {
    encrypted = await maybeEncryptForInput(input)
    fingerprint = encrypted ? await getMasterKeyFingerprint() : null
  } catch (err) {
    if (err instanceof MasterKeyConfigurationError) {
      throw credentialEncryptionConfigurationError(err)
    }
    throw err
  }
  const baseUrl =
    input.authMode === 'baseUrl' ? input.baseUrl : null

  const result = await getConvex().mutation(api.aiCredentials.create, {
    userId,
    providerId: input.providerId,
    authMode: input.authMode,
    displayLabel: input.displayLabel,
    ciphertext: encodeBytes(encrypted?.ciphertext ?? null),
    iv: encodeBytes(encrypted?.iv ?? null),
    baseUrl,
    keyFingerprint: fingerprint,
  })
  if (!result.ok) {
    throw new CredentialError(
      `A credential named "${input.displayLabel}" already exists for this provider.`,
      409,
    )
  }
  return wireToRecord(result.row)
}

async function maybeEncryptForInput(
  input: CreateCredentialInput,
): Promise<EncryptedSecret | null> {
  if (input.authMode === 'apiKey') {
    return encryptKey(input.apiKey)
  }
  // baseUrl mode: API key is optional (bearer-protected proxies)
  if (input.apiKey && input.apiKey.length > 0) return encryptKey(input.apiKey)
  return null
}

async function encryptKey(plaintext: string): Promise<EncryptedSecret> {
  const masterKey = await loadMasterKey()
  return encryptSecret(masterKey, plaintext)
}

/**
 * Patch a credential row. Pass only the fields to update. Auth mode is NOT
 * patchable — to switch modes the caller deletes + creates instead. Returns
 * the updated record, or null if the row doesn't exist / belongs to a
 * different user.
 */
export async function updateCredentialForUser(
  _db: DbClient,
  userId: string,
  credentialId: string,
  patch: UpdateCredentialInput,
): Promise<CredentialRecord | null> {
  const existing = await readCredentialForUser(_db, userId, credentialId)
  if (!existing) return null

  const nextLabel = patch.displayLabel ?? existing.displayLabel
  const nextBaseUrl =
    patch.baseUrl !== undefined ? patch.baseUrl : existing.baseUrl

  let nextCiphertext = existing.ciphertext
  let nextIv = existing.iv
  let nextFingerprint = existing.keyFingerprint
  if (patch.apiKey !== undefined) {
    if (patch.apiKey.length === 0 && existing.authMode === 'apiKey') {
      throw new CredentialError(
        'API key cannot be empty for apiKey-mode credentials.',
        400,
      )
    }
    if (patch.apiKey.length === 0) {
      // baseUrl mode clearing optional bearer
      nextCiphertext = null
      nextIv = null
      nextFingerprint = null
    } else {
      try {
        const encrypted = await encryptKey(patch.apiKey)
        nextCiphertext = encrypted.ciphertext
        nextIv = encrypted.iv
        nextFingerprint = await getMasterKeyFingerprint()
      } catch (err) {
        if (err instanceof MasterKeyConfigurationError) {
          throw credentialEncryptionConfigurationError(err)
        }
        throw err
      }
    }
  }

  const result = await getConvex().mutation(api.aiCredentials.update, {
    userId,
    credentialId,
    displayLabel: nextLabel,
    ciphertext: encodeBytes(nextCiphertext),
    iv: encodeBytes(nextIv),
    baseUrl: nextBaseUrl,
    keyFingerprint: nextFingerprint,
  })
  if (!result.ok) {
    if (result.reason === 'not_found') return null
    throw new CredentialError(
      `A credential named "${nextLabel}" already exists for this provider.`,
      409,
    )
  }
  return wireToRecord(result.row)
}

/**
 * Hard-delete a credential. Rejected at the DB layer when the row is the
 * current default for any scope (FK `on delete restrict` on `ai_defaults`).
 *
 * Returns true when a row was deleted, false otherwise (404).
 */
export async function deleteCredentialForUser(
  _db: DbClient,
  userId: string,
  credentialId: string,
): Promise<boolean> {
  // The SQL FK `on delete restrict` on `ai_defaults` is replaced by an explicit
  // reference check inside the mutation (§4.x): a referenced credential returns
  // `'in_use'`, which we surface as the same 409 the FK violation produced.
  const result = await getConvex().mutation(api.aiCredentials.remove, {
    userId,
    credentialId,
  })
  if (result === 'in_use') {
    throw new CredentialError(
      'This credential is currently set as a default — change the default in /admin/ai/defaults before deleting.',
      409,
    )
  }
  return result === 'deleted'
}

/**
 * Touch `last_used_at`. Called by the chat handler after a successful
 * stream so the UI can show "last used 5 minutes ago" per row.
 *
 * Best-effort: no error if the row vanishes mid-stream (cleanup race).
 */
export async function touchCredentialLastUsed(
  _db: DbClient,
  credentialId: string,
): Promise<void> {
  await getConvex().mutation(api.aiCredentials.touchLastUsed, { credentialId })
}

// ---------------------------------------------------------------------------
// Internals — error classification
// ---------------------------------------------------------------------------

function credentialEncryptionConfigurationError(
  err: MasterKeyConfigurationError,
): CredentialError {
  return new CredentialError(
    `AI credential encryption is not configured: ${err.message.replace('[secrets/masterKey] ', '')}`,
    500,
  )
}
