import type { DbClient } from '../db/client'
import { rowToUser, type AuthUser, type JoinedUserRow } from '../repositories/users'
import { api, getConvex } from '../convex/client'
import { deriveDeviceLabel } from './deviceLabel'

const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 30

/**
 * Debounce window for the per-request `last_seen_at` touch. Every authenticated
 * request used to fire an unconditional `update sessions set last_seen_at` —
 * a WAL-serialized write on SQLite, a hot-row lock on Postgres. The session
 * idle timeout is 30 days, so letting `last_seen_at` drift up to 30s stale is
 * functionally irrelevant; the in-memory tracker below collapses the write to
 * at most one per session per window. This also caps the per-request
 * server→Convex round-trips (the touch mutation only fires once per window).
 */
const LAST_SEEN_TOUCH_DEBOUNCE_MS = 30_000

/**
 * Hard cap on the tracker map so a long-running process that rotates through
 * many session hashes can't leak memory. When exceeded the map is cleared
 * wholesale — the only cost is one redundant `last_seen_at` write per active
 * session right after the reset.
 */
const LAST_SEEN_TRACKER_MAX_ENTRIES = 10_000

/** idHash -> epoch ms of the last `last_seen_at` write we issued for it. */
const lastSeenTouchedAt = new Map<string, number>()

/**
 * The hydrated user the session lookup resolves, paired with the session's own
 * `mfa_passed_at` for the per-session MFA gate. The Convex query returns the
 * joined user row with the MFA-secret blobs base64-encoded (Convex stores them
 * that way, §6); `decodeMfaSecret` turns them back into bytes so `rowToUser`
 * sees exactly its `JoinedUserRow` contract.
 */
type SessionUserWireRow = Omit<
  JoinedUserRow,
  'mfa_totp_secret_ciphertext' | 'mfa_totp_secret_iv'
> & {
  mfa_totp_secret_ciphertext: string | null
  mfa_totp_secret_iv: string | null
  session_mfa_passed_at: string | null
}

interface ResolvedSessionUser {
  user: AuthUser
  sessionMfaPassedAt: string | null
}

interface RotatedSession {
  expiresAt: Date
}

function sessionIdleCutoff(now = Date.now()): Date {
  return new Date(now - SESSION_IDLE_TIMEOUT_MS)
}

function decodeMfaSecret(value: string | null): Uint8Array | null {
  return value === null ? null : new Uint8Array(Buffer.from(value, 'base64'))
}

/**
 * Look up the live session for `idHash` and hydrate its user. Returns `null`
 * when the session is missing / revoked / expired / idle-timed-out, or its user
 * is inactive / soft-deleted / has a missing role — the exact union of "row
 * disappears" conditions the old SQL `sessions JOIN users JOIN roles` produced.
 */
async function resolveSessionUser(
  idHash: string,
  now: number,
): Promise<ResolvedSessionUser | null> {
  const row: SessionUserWireRow | null = await getConvex().query(
    api.sessions.findUserRowBySessionHash,
    {
      idHash,
      nowIso: new Date(now).toISOString(),
      idleCutoffIso: sessionIdleCutoff(now).toISOString(),
    },
  )
  if (!row) return null

  const { session_mfa_passed_at, ...userWire } = row
  const joined: JoinedUserRow = {
    ...userWire,
    mfa_totp_secret_ciphertext: decodeMfaSecret(userWire.mfa_totp_secret_ciphertext),
    mfa_totp_secret_iv: decodeMfaSecret(userWire.mfa_totp_secret_iv),
  }
  return { user: rowToUser(joined), sessionMfaPassedAt: session_mfa_passed_at }
}

export async function createSession(
  _db: DbClient,
  input: {
    idHash: string
    userId: string
    expiresAt: Date
    ipAddress: string | null
    userAgent: string | null
    /**
     * Optional override for the device label. Falls back to a UA-derived
     * label, then the empty string. Empty is acceptable — the schema allows
     * it as a not-null sentinel and the UI renders "Unknown device".
     */
    deviceLabel?: string
    mfaPassedAt?: Date | null
    /**
     * Pre-open a step-up window on the row. Production code never sets
     * this at session creation — step-up is opened by `rotateSessionToken`
     * after a fresh password re-entry. Tests use it to skip the step-up
     * dance when verifying handlers that require a step-up gate.
     */
    stepUpExpiresAt?: Date | null
  },
): Promise<void> {
  const deviceLabel = input.deviceLabel ?? deriveDeviceLabel(input.userAgent)
  await getConvex().mutation(api.sessions.createSession, {
    idHash: input.idHash,
    userId: input.userId,
    expiresAt: input.expiresAt.toISOString(),
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    deviceLabel,
    mfaPassedAt: input.mfaPassedAt != null ? input.mfaPassedAt.toISOString() : null,
    stepUpExpiresAt:
      input.stepUpExpiresAt != null ? input.stepUpExpiresAt.toISOString() : null,
  })
}

export async function findUserBySessionHash(
  _db: DbClient,
  idHash: string,
  now = Date.now(),
): Promise<AuthUser | null> {
  const resolved = await resolveSessionUser(idHash, now)
  if (!resolved) return null
  const { user, sessionMfaPassedAt } = resolved
  if (user.mfaEnabled && sessionMfaPassedAt == null) return null

  await touchSessionLastSeen(idHash, now)
  return user
}

/**
 * Update `sessions.last_seen_at` for an authenticated request, debounced to at
 * most once per `LAST_SEEN_TOUCH_DEBOUNCE_MS` per session. The first touch for
 * a hash always writes; subsequent touches inside the window are skipped. See
 * `LAST_SEEN_TOUCH_DEBOUNCE_MS` for why the staleness is harmless.
 */
async function touchSessionLastSeen(idHash: string, now: number): Promise<void> {
  const lastTouched = lastSeenTouchedAt.get(idHash)
  if (lastTouched !== undefined && now - lastTouched < LAST_SEEN_TOUCH_DEBOUNCE_MS) return

  if (lastSeenTouchedAt.size >= LAST_SEEN_TRACKER_MAX_ENTRIES) lastSeenTouchedAt.clear()
  lastSeenTouchedAt.set(idHash, now)
  await getConvex().mutation(api.sessions.touchLastSeen, { idHash })
}

export async function sessionRequiresMfa(_db: DbClient, idHash: string): Promise<boolean> {
  const resolved = await resolveSessionUser(idHash, Date.now())
  if (!resolved) return false
  return resolved.user.mfaEnabled && resolved.sessionMfaPassedAt == null
}

export async function findUserByPendingMfaSessionHash(
  _db: DbClient,
  idHash: string,
): Promise<AuthUser | null> {
  const resolved = await resolveSessionUser(idHash, Date.now())
  if (!resolved) return null
  const { user, sessionMfaPassedAt } = resolved
  if (!user.mfaEnabled || sessionMfaPassedAt != null) return null
  return user
}

export async function revokeSessionByHash(_db: DbClient, idHash: string): Promise<void> {
  await getConvex().mutation(api.sessions.revokeByHash, { idHash })
}

/**
 * Read the `step_up_expires_at` column for a single live session. Used by
 * `requireStepUp` in `authz.ts` to decide whether the cookie's owner is
 * inside their fresh re-auth window.
 *
 * Returns `null` when the session doesn't exist, has been revoked, or has
 * never had a step-up grant. Callers must treat null as "needs step-up".
 */
export async function getSessionStepUpExpiresAt(
  _db: DbClient,
  idHash: string,
): Promise<Date | null> {
  const value = await getConvex().query(api.sessions.getStepUpExpiresAt, { idHash })
  return value ? new Date(value) : null
}

export async function rotateSessionToken(
  _db: DbClient,
  currentIdHash: string,
  input: {
    nextIdHash: string
    mfaPassedAt?: Date | null
    stepUpExpiresAt?: Date | null
  },
): Promise<RotatedSession | null> {
  // `mfaPassedAt` / `stepUpExpiresAt` are tri-state: omit the key to inherit the
  // current row, send a value (incl. null) to override. Build the args object
  // so an absent key stays absent — Convex's wire format has no `undefined`.
  const args: {
    currentIdHash: string
    nextIdHash: string
    mfaPassedAt?: string | null
    stepUpExpiresAt?: string | null
  } = { currentIdHash, nextIdHash: input.nextIdHash }
  if (input.mfaPassedAt !== undefined) {
    args.mfaPassedAt = input.mfaPassedAt === null ? null : input.mfaPassedAt.toISOString()
  }
  if (input.stepUpExpiresAt !== undefined) {
    args.stepUpExpiresAt =
      input.stepUpExpiresAt === null ? null : input.stepUpExpiresAt.toISOString()
  }

  const result = await getConvex().mutation(api.sessions.rotate, args)
  if (!result) return null
  return { expiresAt: new Date(result.expiresAt) }
}

export async function markSessionMfaPassed(
  _db: DbClient,
  idHash: string,
  passedAt: Date = new Date(),
): Promise<void> {
  await getConvex().mutation(api.sessions.markMfaPassed, {
    idHash,
    passedAt: passedAt.toISOString(),
  })
}
