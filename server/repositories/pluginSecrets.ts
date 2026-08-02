/**
 * Plugin secret settings repository — CRUD over `plugin_secrets`.
 *
 * Plugin settings declared `secret: true` in the manifest are encrypted at
 * rest with the process master key (server/secrets/) and stored here, one
 * row per `(plugin_id, setting_id)`. They NEVER live in
 * `installed_plugins.settings_json` — the split is structural, so a settings
 * read can't leak plaintext onto a browser-bound payload by accident.
 *
 * Owns:
 *   - Encryption on write + decryption on read (the process master key — it
 *     stays Bun-side and NEVER enters the Convex V8 runtime, §6).
 *   - The `'***'` sentinel semantics at the persistence boundary
 *     (`applyPluginSecretSettings`): sentinel preserves the stored row,
 *     a new string rotates it, the empty string deletes it.
 *   - The wire-safe `PluginSecretState` projection — `listPluginSecretStates`
 *     is the ONLY shape from this table that may cross the HTTP boundary.
 *
 * Does NOT own:
 *   - HTTP semantics (handlers map `PluginSecretError.status` to envelopes).
 *   - The `settings_json` column (`plugins.ts` owns `installed_plugins`).
 *
 * Convex port: the read/write bodies are thin adapters over
 * `convex/pluginSecrets.ts` (docs/CONVEX-MIGRATION.md §2). Crypto runs here;
 * only base64 `ciphertext` / `iv` strings cross the wire — Convex never sees
 * the master key or plaintext.
 *
 * Gated by `plugin-secrets-never-leak.test.ts`.
 *
 * @see convex/pluginSecrets.ts — the Convex persistence functions
 */

import { api, getConvex } from '../convex/client'
import {
  decryptSecret,
  encryptSecret,
} from '../secrets/encryption'
import {
  getMasterKeyFingerprint,
  loadMasterKey,
  MasterKeyConfigurationError,
} from '../secrets/masterKey'
import {
  SECRET_SETTING_MASK,
  type PluginSettingDefinition,
  type PluginSettingsValues,
} from '@core/plugin-sdk'

/** Base64-encode AES-GCM bytes for transport to Convex (which stores them base64). */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** Decode the base64 `ciphertext` / `iv` Convex returns back into bytes for decryption. */
function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

/**
 * Typed error for secret persistence failures that handlers turn into a
 * `{ error }` envelope. Mirrors `CredentialError` in the AI store.
 */
export class PluginSecretError extends Error {
  readonly status: number

  constructor(message: string, status = 400, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginSecretError'
    this.status = status
  }
}

function secretEncryptionConfigurationError(
  err: MasterKeyConfigurationError,
): PluginSecretError {
  return new PluginSecretError(
    `Plugin secret encryption is not configured: ${err.message.replace('[secrets/masterKey] ', '')}`,
    500,
    { cause: err },
  )
}

// ---------------------------------------------------------------------------
// Wire-safe projection
// ---------------------------------------------------------------------------

/**
 * Per-field presence + rotation state. This is the ONLY shape from
 * `plugin_secrets` that may inform a browser-bound payload: handlers render
 * a stored secret as the `'***'` sentinel and a fingerprint mismatch as
 * "needs re-entry". No ciphertext, IV, or plaintext ever crosses.
 */
export interface PluginSecretState {
  settingId: string
  keyFingerprintCurrent: boolean
}

export async function listPluginSecretStates(
  pluginId: string,
): Promise<PluginSecretState[]> {
  const rows = await getConvex().query(api.pluginSecrets.listStates, { pluginId })
  if (rows.length === 0) return []
  const current = await currentFingerprintOrNull(pluginId)
  return rows.map((row: { setting_id: string; key_fingerprint: string }) => ({
    settingId: row.setting_id,
    keyFingerprintCurrent: row.key_fingerprint === current,
  }))
}

/**
 * A missing/misconfigured master key must not 500 a plugins list — every
 * stored secret simply reports "needs re-entry" until the key is fixed.
 */
async function currentFingerprintOrNull(pluginId: string): Promise<string | null> {
  try {
    return await getMasterKeyFingerprint()
  } catch (err) {
    console.error(`[plugin:${pluginId}] master key unavailable while reading secret states:`, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Runtime resolution — the ONLY plaintext exit
// ---------------------------------------------------------------------------

/**
 * Decrypt a plugin's stored secrets into a plaintext record, keyed by
 * setting id.
 *
 * SERVER-SIDE RUNTIME USE ONLY. The returned record seeds the QuickJS
 * worker's `api.cms.settings.get` mirror and the `settings.changed` hook
 * payload — it must NEVER be serialised onto a browser-bound response.
 * The `plugin-secrets-never-leak.test.ts` gate bans this import from every
 * HTTP handler.
 *
 * Failure posture: plugin load must not crash on a stale secret. A
 * fingerprint mismatch (master key rotated) or decrypt failure skips the
 * field — the worker sees it absent (falls back to the empty value in
 * `plugin.settings`) — and logs with the `[plugin:<id>]` prefix so the
 * operator knows re-entry is needed.
 */
export async function resolvePluginSecretsForRuntime(
  pluginId: string,
  declared: ReadonlyArray<PluginSettingDefinition>,
): Promise<Record<string, string>> {
  const secretIds = new Set(declared.filter((s) => s.secret).map((s) => s.id))
  if (secretIds.size === 0) return {}

  const rows = await getConvex().query(api.pluginSecrets.listForRuntime, { pluginId })
  if (rows.length === 0) return {}

  let masterKey: CryptoKey
  let currentFingerprint: string
  try {
    masterKey = await loadMasterKey()
    currentFingerprint = await getMasterKeyFingerprint()
  } catch (err) {
    console.error(`[plugin:${pluginId}] master key unavailable; plugin secrets withheld from runtime:`, err)
    return {}
  }

  const out: Record<string, string> = {}
  for (const row of rows) {
    // Orphan rows (setting removed from the manifest by an upgrade) are
    // skipped — only currently-declared secrets reach the worker.
    if (!secretIds.has(row.setting_id)) continue
    if (row.key_fingerprint !== currentFingerprint) {
      console.error(
        `[plugin:${pluginId}] secret setting "${row.setting_id}" was encrypted with a ` +
        `different master key — re-enter it in the plugin's settings.`,
      )
      continue
    }
    try {
      // Convex returns ciphertext/iv as base64 strings — decode to bytes for
      // the AES-GCM decrypt (the master key never leaves the Bun server).
      out[row.setting_id] = await decryptSecret(masterKey, {
        ciphertext: fromBase64(row.ciphertext),
        iv: fromBase64(row.iv),
      })
    } catch (err) {
      console.error(`[plugin:${pluginId}] failed to decrypt secret setting "${row.setting_id}":`, err)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Apply the secret-field slice of a validated settings record to
 * `plugin_secrets`, returning the remaining record (secret ids stripped)
 * for `settings_json`. The single persistence-side implementation of the
 * sentinel semantics:
 *
 *   - `'***'` (SECRET_SETTING_MASK) — the admin form round-tripped the
 *     masked GET value untouched: the stored row is preserved as-is.
 *   - empty string — deliberately clears: the row is deleted.
 *   - any other string — rotates: encrypted with the live master key and
 *     upserted, fingerprint recorded.
 *
 * Throws `PluginSecretError` (status 500) when the master key is
 * misconfigured — handlers surface it as a `{ error }` envelope.
 */
export async function applyPluginSecretSettings(
  pluginId: string,
  declared: ReadonlyArray<PluginSettingDefinition>,
  settings: PluginSettingsValues,
): Promise<PluginSettingsValues> {
  const secretDefs = declared.filter((s) => s.secret)
  if (secretDefs.length === 0) return { ...settings }

  const secretIds = new Set(secretDefs.map((s) => s.id))
  const plain: PluginSettingsValues = {}
  for (const [key, value] of Object.entries(settings)) {
    if (!secretIds.has(key)) plain[key] = value
  }

  for (const def of secretDefs) {
    const value = settings[def.id]
    // Secrets are string-typed by manifest validation; the sentinel means
    // "unchanged" so the stored row stays untouched (including a row that
    // currently needs re-entry — preserving it keeps the warning honest).
    if (typeof value !== 'string' || value === SECRET_SETTING_MASK) continue
    if (value === '') {
      await deletePluginSecret(pluginId, def.id)
    } else {
      await writePluginSecret(pluginId, def.id, value)
    }
  }
  return plain
}

/**
 * Seed encrypted rows for secret settings that declare a non-empty manifest
 * default. Insert-if-absent (`on conflict do nothing`) so the upsert-based
 * upgrade and rollback flows never clobber a value the site owner rotated.
 */
export async function seedPluginSecretDefaults(
  pluginId: string,
  declared: ReadonlyArray<PluginSettingDefinition>,
): Promise<void> {
  for (const def of declared) {
    if (!def.secret || typeof def.default !== 'string' || def.default === '') continue
    const { ciphertext, iv, fingerprint } = await encryptPluginSecret(pluginId, def.default)
    await getConvex().mutation(api.pluginSecrets.seedDefault, {
      pluginId,
      settingId: def.id,
      ciphertext: toBase64(ciphertext),
      iv: toBase64(iv),
      keyFingerprint: fingerprint,
    })
  }
}

async function writePluginSecret(
  pluginId: string,
  settingId: string,
  plaintext: string,
): Promise<void> {
  const { ciphertext, iv, fingerprint } = await encryptPluginSecret(pluginId, plaintext)
  await getConvex().mutation(api.pluginSecrets.upsert, {
    pluginId,
    settingId,
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv),
    keyFingerprint: fingerprint,
  })
}

async function deletePluginSecret(pluginId: string, settingId: string): Promise<void> {
  await getConvex().mutation(api.pluginSecrets.remove, { pluginId, settingId })
}

async function encryptPluginSecret(
  pluginId: string,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array; fingerprint: string }> {
  try {
    const masterKey = await loadMasterKey()
    const { ciphertext, iv } = await encryptSecret(masterKey, plaintext)
    return { ciphertext, iv, fingerprint: await getMasterKeyFingerprint() }
  } catch (err) {
    if (err instanceof MasterKeyConfigurationError) {
      throw secretEncryptionConfigurationError(err)
    }
    throw new Error(`[plugin:${pluginId}] failed to encrypt secret setting`, { cause: err })
  }
}
