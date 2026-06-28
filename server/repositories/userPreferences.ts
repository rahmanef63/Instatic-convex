/**
 * User preferences repository — CRUD over the `user_preferences` table.
 *
 * One row per (user_id, key). The preference payload is the hydrated JS value;
 * its JSON (de)serialisation now lives in the Convex functions (the
 * `value_json` blob is opaque at the data layer — see
 * docs/CONVEX-MIGRATION.md §6).
 *
 * Schema validation lives at the HTTP boundary, not in this repository. The
 * handler validates incoming payloads against the per-key TypeBox schemas in
 * `src/core/persistence/userPreferences.ts` before this repository ever sees
 * them, and re-validates on read. We pass `unknown` around inside the repo so
 * the type system doesn't lie about contents.
 *
 * Convex port: this file is now a thin adapter over `convex/userPreferences.ts`
 * (see §2). The bodies read/write through the shared `getConvex()` handle. All
 * row-shaping, the read-then-patch upsert, and `updated_at` generation now live
 * in the Convex functions.
 *
 * @see convex/userPreferences.ts  — the Convex query/mutation functions
 */
import { api, getConvex } from '../convex/client'

/**
 * Read a single preference. Returns `null` when the row doesn't exist
 * (user hasn't ever set this preference). Callers fall back to a
 * sensible default — first read of a key for a fresh user is the
 * common case and not an error.
 *
 * NB: the client-side helper in `@core/persistence/userPreferences`
 * uses the unprefixed name (`getUserPreference`) for the HTTP round-trip.
 * This is the server-side counterpart — the `…Row` suffix mirrors other
 * repository conventions (e.g. `readMediaAssetRow`).
 */
export async function getUserPreferenceRow(
  userId: string,
  key: string,
): Promise<unknown | null> {
  return getConvex().query(api.userPreferences.get, { userId, key })
}

/**
 * Upsert a preference. The Convex function serialises `value` to the
 * `value_json` blob and stamps `updated_at` with the current timestamp on
 * every write — even a no-op overwrite — so admins can see "last touched" if
 * we ever surface a preferences-debug page.
 */
export async function upsertUserPreferenceRow(
  userId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await getConvex().mutation(api.userPreferences.upsert, { userId, key, value })
}

/**
 * Delete a preference, resetting it to its default on the next read.
 * Returns true when a row was actually deleted, false when nothing was
 * stored (callers can treat both as "now using default" without
 * distinguishing — the wire-level handler returns 204 either way).
 */
export async function deleteUserPreferenceRow(
  userId: string,
  key: string,
): Promise<boolean> {
  return getConvex().mutation(api.userPreferences.del, { userId, key })
}
