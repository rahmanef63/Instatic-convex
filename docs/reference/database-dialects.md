# Data Layer (Convex)

How the CMS persists data, what the conventions are, and where the boundaries sit.

Instatic's data layer is **native, self-hosted Convex**. The schema is one declarative file (`convex/schema.ts`) and every read/write is a Convex query or mutation in `convex/*.ts`. The Bun server reaches it through a single client; the browser never holds a Convex token.

Full architecture — calling convention, transaction mapping, the hard cases (search, upserts, hand-joins, leases): [docs/CONVEX-MIGRATION.md](../CONVEX-MIGRATION.md). Deploy reference: [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md).

---

## TL;DR

- **One client** (`server/convex/client.ts`) — a long-lived `ConvexHttpClient` pointed at `CONVEX_SELF_HOSTED_URL` and authenticated with the self-hosted admin key. The Bun server is a fully trusted backend; user identity travels as explicit function args, not on the channel.
- **Repositories are thin pass-throughs.** Every `server/repositories/*.ts` function keeps its frozen signature and just marshals args to `getConvex().query/mutation(api.<module>.<fn>, args)`. All logic lives in `convex/*.ts`.
- **App-generated PKs use the `by_app_id` index**, stored as `v.string()` — not Convex's `_id`.
- **`*_json` columns stay opaque `v.string()`** and are `JSON.parse`d explicitly; searchable scalars are hoisted to their own indexed fields.
- **Changing the schema** means editing `convex/schema.ts`; Convex applies schema changes on deploy. There are no migration files and no DDL at boot.

---

## The conventions

### 1 — Repositories are thin pass-throughs

The public surface of every `server/repositories/*.ts` (exported function names, parameter order, return shapes) is frozen — handlers and the React UI keep calling them unchanged. The body just marshals args into a Convex call and unwraps the result:

```ts
export async function revokeSessionByHashForUser(
  sessionHash: string,
  userId: string,
): Promise<boolean> {
  return getConvex().mutation(api.sessions.revokeByHashForUser, { sessionHash, userId })
}
```

All real logic — ownership checks, soft-delete filters, read-before-write upserts, hand-assembled joins — lives in the matching `convex/*.ts` function. A SQL `LEFT JOIN` becomes a hand-assembled join inside a Convex query; the repository's return shape is unchanged.

### 2 — App-generated string ids, not Convex `_id`

Every table uses an **app-generated nanoid `id`** (or a composite/natural key like `sessions.id_hash`). These ids are load-bearing: they live in cookies, in cross-table references, in export bundles, and in URLs. They stay.

- The id is a normal indexed string field: `id: v.string()` + `.index('by_app_id', ['id'])`. It is the identity every repository, handler, and export uses.
- Convex's `_id` is an **internal opaque handle** used only for `ctx.db.patch(_id, …)` / `ctx.db.delete(_id)` inside a handler after a lookup by app id. It never leaks into return shapes, the REST API, or bundles.
- Cross-domain references stay `v.string()` app ids, never `v.id(...)`. Referential integrity is enforced in application code.

```ts
const byAppId = (ctx, table, id) =>
  ctx.db.query(table).withIndex('by_app_id', (q) => q.eq('id', id)).unique()
```

### 3 — `*_json` columns stay opaque strings

Every column intended to store JSON has a name ending in `_json` and the type `v.string()` (`cells_json`, `manifest_json`, `variants_json`, `settings_json`, …). There is **no auto-parse** — every read site `JSON.parse`s explicitly (`safeParseJson` / `parseJsonWithFallback`), and every write `JSON.stringify`s.

Any field that needs to be **filtered, sorted, or searched** is hoisted out of the JSON blob into its own top-level document field with its own index (e.g. `data_rows.slug`). Operator-DSL filters that reach arbitrary JSON paths fetch a candidate set by indexed fields and apply the operators in JS inside the handler. Cross-table substring search uses a Convex `searchIndex` over a denormalized lowercased `search_text` field. See [CONVEX-MIGRATION.md §4](../CONVEX-MIGRATION.md).

---

## Schema and types

`convex/schema.ts` is the single source of truth for tables, fields, and indexes:

- `integer` boolean (`0/1`) → `v.boolean()`.
- `*_json` text → `v.string()` (opaque blob, parsed in app).
- nullable text → `v.union(v.null(), v.string())`.
- small binary (IVs, ciphertext) → base64 `v.string()`; large bytes → Convex File Storage.
- enum CHECK constraints → `v.union(v.literal(...), …)`, validated at the Convex arg boundary **and** at the HTTP boundary via TypeBox.
- each app-id column gets `.index('by_app_id', ['id'])`; every other lookup gets a `.index(...)` on the same column tuple.

Convex versions and deploys the schema. There is no `schema_migrations` table and no `runMigrations` at boot — a schema change ships when `convex deploy` runs (handled by the sc-git pre-push hook; see [DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md)).

---

## Transactions

A Convex **mutation is atomic** over every document it touches — the whole handler is the transaction, with no `BEGIN/COMMIT`. Multi-row writes that must be consistent (token rotation, import replace-all, publish, reconcile) each collapse into a single mutation; a crash mid-handler rolls the whole thing back. The risk that replaces "did the transaction commit?" is the **size/time limit of one mutation**: very large batch writes (e.g. a multi-thousand-page publish) are chunked into a coordinator action that calls many small mutations, trading atomicity for progress. Each chunked site documents that trade. See [CONVEX-MIGRATION.md §3](../CONVEX-MIGRATION.md).

---

## Related

- [docs/CONVEX-MIGRATION.md](../CONVEX-MIGRATION.md) — full data-layer architecture (the authoritative contract)
- [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) — self-hosted Convex deploy reference
- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — server-side flow including the Convex client
- Source-of-truth files:
  - `convex/schema.ts` — tables, fields, indexes
  - `convex/*.ts` — query/mutation functions per domain
  - `server/convex/client.ts` — the server-side Convex handle
  - `server/repositories/*.ts` — thin pass-throughs with frozen signatures
