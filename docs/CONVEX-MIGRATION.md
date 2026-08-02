# Convex Migration Architecture

Porting the Instatic CMS data layer from its dual SQL backend (Postgres via
`Bun.SQL` / SQLite via `bun:sqlite`) to **native, self-hosted Convex**.

Status: design document. No code in this doc is wired yet (`package.json` has no
`convex` dependency at time of writing). This is the contract every porting PR
must follow.

---

## 0. The one-paragraph summary

Instatic stays exactly as it is above the data layer: the **Bun HTTP server**
(`server/index.ts` → `server/router.ts` → handlers) and the **React/Vite
frontend** (`src/`) do not change their architecture. What changes is the single
`DbClient` object threaded through every repository. Today `createDbClient(url)`
returns a tagged-template SQL client. Tomorrow we return a thin object backed by
a **`ConvexHttpClient`** pointed at a self-hosted Convex backend
(`CONVEX_SELF_HOSTED_URL`) authenticated with the **admin/deploy key**. Every
`server/repositories/*.ts` keeps its exported function signatures byte-for-byte;
only the bodies change from SQL strings to `convex.query(...)` /
`convex.mutation(...)` calls. The 33 SQL `CREATE TABLE`s become one
`convex/schema.ts`. The 19 `db.transaction(...)` blocks become 19 Convex
mutations. When the last repository is ported, the whole `server/db/*` directory
is deleted.

---

## 1. Target architecture

### 1.1 Who talks to Convex, and how

Instatic's trust model is **server-centric**, not browser-centric. The browser
never holds a Convex token. The React admin shell calls the Bun server's REST
API (`/admin/api/...`), the Bun server resolves the session cookie into an
`AuthUser`, and only *then* does trusted server code touch the database. We
preserve this exactly.

Therefore:

- **Transport:** `ConvexHttpClient` (from the `convex/browser` entrypoint —
  works fine in Bun) pointed at `CONVEX_SELF_HOSTED_URL`. One long-lived client
  for the whole server process, mirroring today's single `DbClient`.
- **Authentication of the server→Convex channel:** the Convex **admin key**
  (a.k.a. self-hosted deploy key). The Bun server is a fully trusted backend, so
  it calls Convex functions with admin privileges via
  `client.setAdminAuth(adminKey)`. We do **not** use Convex's end-user auth on
  this channel — there is no browser-issued JWT here.
- **User identity:** because the *server* holds the session (not the browser),
  the acting user is passed **explicitly as a function argument**
  (`actorUserId`, `userId`, etc.) to every Convex function that needs it. This
  is identical to how today's repositories already take `userId` parameters
  (see `revokeSessionByHashForUser(db, sessionHash, userId)`). Cross-user
  guards stay as `WHERE user_id = ...` predicates re-expressed as Convex
  index lookups + in-handler checks.

This is the key decision: **identity is data, not ambient auth context.** Convex
functions receive the actor id as a validated arg and enforce ownership inside
the handler. We never rely on `ctx.auth.getUserIdentity()` for the
server→Convex channel.

### 1.2 `server/convex/client.ts`

```ts
// server/convex/client.ts
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../convex/_generated/api'
import type { FunctionReference } from 'convex/server'

/**
 * The server-side Convex handle. Replaces the SQL `DbClient`.
 *
 * One instance per server process (mirrors the single SQL DbClient created in
 * server/index.ts). Authenticated with the self-hosted ADMIN key, because the
 * Bun server is a fully trusted backend — every CMS capability check has
 * already happened in the HTTP handler before we get here. User identity is
 * NOT carried on this channel; it is passed as explicit function args.
 */
export interface ConvexClient {
  query<Args, Ret>(fn: FunctionReference<'query', 'public', Args, Ret>, args: Args): Promise<Ret>
  mutation<Args, Ret>(fn: FunctionReference<'mutation', 'public', Args, Ret>, args: Args): Promise<Ret>
  action<Args, Ret>(fn: FunctionReference<'action', 'public', Args, Ret>, args: Args): Promise<Ret>
  readonly api: typeof api
}

export interface ConvexConfig {
  url: string       // CONVEX_SELF_HOSTED_URL, e.g. https://api-instatic.example.com
  adminKey: string  // CONVEX_SELF_HOSTED_ADMIN_KEY / deploy key
}

export function createConvexClient(config: ConvexConfig): ConvexClient {
  const http = new ConvexHttpClient(config.url)
  // Self-hosted admin auth: lets the trusted server invoke any function with
  // full privileges. There is no per-request token swap — identity travels in
  // the args, not the channel.
  http.setAdminAuth(config.adminKey)

  return {
    query: (fn, args) => http.query(fn, args),
    mutation: (fn, args) => http.mutation(fn, args),
    action: (fn, args) => http.action(fn, args),
    api,
  }
}
```

### 1.3 Wiring it in `server/index.ts`

Today:

```ts
const { db, migrations } = createDbClient(config.databaseUrl)
await runMigrations(db, migrations)
await syncSystemRoles(db)
```

After:

```ts
const convex = createConvexClient({
  url: config.convexUrl,         // CONVEX_SELF_HOSTED_URL
  adminKey: config.convexAdminKey,
})
// No runMigrations — schema is declarative (convex/schema.ts), deployed by
// `convex deploy` out-of-band. No DDL at boot.
await syncSystemRoles(convex)    // still runs: it's a data upsert, not DDL
```

The object passed through `runtime.db` in `server/router.ts` becomes the
`ConvexClient`. To minimise churn in handlers during the migration, we keep the
property name `runtime.db` and let repositories accept the new client type. (A
later cosmetic pass can rename it to `runtime.convex`.)

> **Type-name strategy.** Each ported repository swaps its `db: DbClient`
> parameter for `convex: ConvexClient`. Where touching every handler call-site
> in one PR is too noisy, the repository can accept the union
> `db: DbClient | ConvexClient` during the transition and branch internally —
> but the end state is `ConvexClient` only, and the union is deleted with
> `server/db/*`.

---

## 2. Repository convention

**Invariant:** the public surface of every `server/repositories/*.ts` (exported
function names, parameter order, return shapes) is **frozen**. Handlers and the
React UI keep calling them unchanged. Only the body — the part between `{` and
`}` — is rewritten from SQL to Convex calls.

### Before / after — `revokeSessionByHashForUser`

**Before** (`server/repositories/sessions.ts`, SQL):

```ts
export async function revokeSessionByHashForUser(
  db: DbClient,
  sessionHash: string,
  userId: string,
): Promise<boolean> {
  const result = await db`
    update sessions
    set revoked_at = current_timestamp
    where id_hash = ${sessionHash}
      and user_id = ${userId}
      and revoked_at is null
  `
  return result.rowCount > 0
}
```

**After** (same signature, Convex body):

```ts
export async function revokeSessionByHashForUser(
  convex: ConvexClient,
  sessionHash: string,
  userId: string,
): Promise<boolean> {
  return convex.mutation(convex.api.sessions.revokeByHashForUser, {
    sessionHash,
    userId,
  })
}
```

**The Convex function it calls** (`convex/sessions.ts`) — this is where the
cross-user guard and the `revoked_at is null` predicate move to:

```ts
// convex/sessions.ts
import { mutation } from './_generated/server'
import { v } from 'convex/values'

export const revokeByHashForUser = mutation({
  args: { sessionHash: v.string(), userId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sessionHash, userId }) => {
    // id_hash is the app-generated primary key → its own by_id_hash index.
    const row = await ctx.db
      .query('sessions')
      .withIndex('by_id_hash', (q) => q.eq('id_hash', sessionHash))
      .unique()
    // Cross-user guard: reject another user's session, no-op if already revoked.
    if (!row || row.user_id !== userId || row.revoked_at !== null) return false
    await ctx.db.patch(row._id, { revoked_at: new Date().toISOString() })
    return true
  },
})
```

Two rules that fall out of this:

1. **The repository file becomes a thin adapter.** All real logic (ownership
   checks, soft-delete filters, read-before-write, JSON parsing) lives in
   `convex/*.ts`. The repository just marshals args and unwraps results into the
   shapes handlers already expect.
2. **Hydration that was a SQL `LEFT JOIN` becomes a Convex helper** that does
   the secondary reads (see §4.2). The repository's *return shape* (e.g.
   `DataRow` with nested `author`/`createdBy`/`updatedBy`/`publishedBy`) is
   unchanged; the join is hand-assembled inside the Convex query.

---

## 3. Transaction mapping

Every `db.transaction(...)` site from the cross-cutting analysis collapses into
**one Convex mutation** (Convex mutations are atomic over all the documents they
touch — no nested transactions, no `BEGIN/COMMIT`; the whole handler is the
transaction). Loops inside the old transaction become loops inside the mutation
handler. Where the work spans domains, the mutation lives in the domain that
*owns the durability* (the table whose write must not be lost).

| # | SQL transaction site | Convex mutation | Notes / partial-failure risk |
|---|----------------------|-----------------|------------------------------|
| 1 | `server/db/runMigrations.ts:52` | — (deleted) | No DDL in Convex; schema is declarative. |
| 2 | `server/handlers/cms/setup.ts:68` | `setup.bootstrapInstall` | Create site + owner user + audit event + seed homepage row in one mutation. |
| 3 | `server/auth/sessions.ts:205` | `sessions.rotate` | Read current session + revoke old + insert rotated session. |
| 4 | `server/handlers/cms/import.ts:167` | `import.replaceAll` | Wipe rows/tables/folders/redirects + reinsert. **Largest mutation — see §4.7 chunking.** |
| 5 | `server/handlers/cms/import.ts:258` | `import.mergeAdd` | Upsert tables + insert-if-absent rows/folders/redirects. |
| 6 | `server/handlers/cms/import.ts:300` | `import.mergeUpdate` | Update rows + redirects by id. |
| 7 | `server/repositories/publish.ts:231` | `sitePublish.persistPublish` | Insert site snapshot + loop insert N page versions + loop update N rows. Page-count bound (§4.7). |
| 8 | `server/repositories/data/publish.ts:145` | `dataRowPublish.persistPublish` | Insert version + update row + upsert redirect if slug changed. |
| 9 | `server/repositories/data/rows/reconcile.ts:85` | `dataRows.reconcile` | Reap + two-phase slug park/finalize + create/revive. **Load-bearing statement order preserved (§4.6).** |
| 10 | `server/repositories/data/rows/bulk.ts:27` | `dataRows.createMany` | Loop insert. |
| 11 | `server/repositories/data/rows/bulk.ts:47` | `dataRows.saveDraftMany` | Loop update draft cells. |
| 12 | `server/repositories/data/rows/bulk.ts:70` | `dataRows.softDeleteMany` | Loop soft-delete; track published count. |
| 13 | `server/ai/pricing/store.ts:50` | `aiPricing.saveCachedCatalogue` | Delete-all + loop insert. |
| 14 | `server/ai/conversations/store.ts:340` | `aiConversations.appendMessage` | Compute next position + insert message + bump denormalized totals. |
| 15 | `server/ai/conversations/store.ts:408` | `aiConversations.purgeSoftDeleted` | Count + delete convos + cascade-delete messages (explicit, §4.x). |
| 16 | `server/ai/runtime/persister.ts:191` | `aiConversations.updateMessageTokens` | Update message + bump parent totals. |
| 17 | `server/repositories/media.ts:406` | `media.assignAssetToFolders` | Delete old memberships + upsert new + re-read. |
| 18 | `server/repositories/mediaMigration.ts:302` | `mediaMigration.updateVariantStorageLocation` | Read variants JSON + mutate one entry + write back. Race-prone (§4 note). |
| 19 | (plugin) `installPlugin` / `setPluginSettings` / `recordPluginCrash` / `deletePlugin` | `plugins.install` / `plugins.setSettings` / `plugins.recordCrash` / `plugins.delete` | Span `installed_plugins` + `plugin_secrets` (+ crash/run/schedule cleanup on delete). |

**Partial-failure caveat to document in code:** a Convex mutation IS atomic, so
a crash mid-loop rolls the whole mutation back — *good*. The risk moves to the
**size/time limits** of a single mutation (§4.7): a 5,000-page site publish
cannot be one mutation. Those get chunked into a coordinator action that calls
many small mutations, trading atomicity for progress — and that trade is called
out explicitly at each chunked site.

---

## 4. The hard cases

### 4.1 Advisory locks (scheduler leader election)

`server/db/advisoryLock.ts` uses `pg_try_advisory_lock` so exactly one HA
instance runs each tick loop (conversation purge, plugin scheduler). Convex has
no advisory locks — and **does not need them**: Convex itself is the single
backend, and its scheduler/cron primitives run a job once regardless of how many
Bun instances exist.

**Resolution — two layers:**

1. **Move recurring work into Convex crons.** Replace the in-Bun `setInterval`
   tick loops with `convex/crons.ts`:

   ```ts
   // convex/crons.ts
   import { cronJobs } from 'convex/server'
   import { internal } from './_generated/api'
   const crons = cronJobs()
   crons.interval('purge ai conversations', { hours: 24 }, internal.aiConversations.purgeTick, {})
   crons.interval('plugin scheduler tick', { minutes: 1 }, internal.pluginSchedules.tick, {})
   export default crons
   ```

   Convex guarantees a single execution per scheduled fire — leader election
   evaporates.

2. **Where a lease is still genuinely needed** (e.g. `tryClaimSchedule`'s
   per-schedule lock so two ticks don't double-run the same plugin job), keep
   the lease pattern but back it by an atomic mutation using optimistic
   concurrency instead of `pg_try_advisory_lock`:

   ```ts
   export const tryClaimSchedule = mutation({
     args: { pluginId: v.string(), scheduleId: v.string(), token: v.string(), nowIso: v.string(), leaseMs: v.number() },
     returns: v.boolean(),
     handler: async (ctx, a) => {
       const row = await ctx.db.query('plugin_schedules')
         .withIndex('by_plugin_schedule', (q) => q.eq('plugin_id', a.pluginId).eq('schedule_id', a.scheduleId))
         .unique()
       if (!row) return false
       const lockFree = row.running_token === null || (row.lock_until !== null && row.lock_until <= a.nowIso)
       if (!lockFree) return false  // someone else holds a live lease
       await ctx.db.patch(row._id, {
         running_token: a.token,
         lock_until: new Date(Date.parse(a.nowIso) + a.leaseMs).toISOString(),
       })
       return true
     },
   })
   ```

   Because the mutation is atomic, two concurrent claimants serialise; the
   second sees `lockFree === false` and no-ops. This is the documented
   replacement for `advisoryLock.ts`, which is then deleted.

### 4.2 `json_extract` filtering and `LEFT JOIN` hydration

`server/db/jsonExtract.ts` builds dialect-specific `json_extract(col,'$.f')` /
`col->>'f'` WHERE fragments. Convex has neither operator. Two patterns replace
it:

- **Filter on a JSON field → denormalize the scalar to a top-level column.** The
  one field actually filtered/joined on is already denormalized in the SQL
  schema: `data_rows.slug` is hoisted out of `cells_json` precisely so it can be
  indexed. We extend that rule: any field used in a `WHERE`/`ORDER BY` becomes a
  real document field with its own index. JSON blobs (`cells_json`,
  `manifest_json`, `variants_json`, `settings_json`) stay as opaque
  `v.string()` and are parsed in app code, never queried into.

- **Operator-DSL filtering (`listDataRowsWithFilter`, `listPluginRecords`) that
  reaches arbitrary `json_extract` paths** has no index support. Resolution:
  fetch the candidate set by indexed fields (`table_id`, status, owner), then
  apply the eq/ne/gt/gte/lt/lte/in/like operators **in the Convex query handler
  in JS** over the parsed JSON. This is the same "read object, filter in app"
  fallback the cross-cutting notes call for. It is O(N) over the table slice;
  acceptable at self-hosted CMS scale, flagged where N can be large.

- **`LEFT JOIN users` hydration (the 4× author/createdBy/updatedBy/publishedBy
  refs)** becomes a hand-assembled join inside the Convex query:

  ```ts
  async function hydrateUserRefs(ctx, row) {
    const ids = [row.author_user_id, row.created_by_user_id, row.updated_by_user_id, row.published_by_user_id]
      .filter((x): x is string => x !== null)
    const users = new Map((await Promise.all(
      [...new Set(ids)].map((id) => ctx.db.query('users').withIndex('by_app_id', (q) => q.eq('id', id)).unique()),
    )).filter(Boolean).map((u) => [u!.id, toUserRef(u!)]))
    return { ...toDataRow(row), author: users.get(row.author_user_id ?? '') ?? null, /* …3 more */ }
  }
  ```

  The repository's `DataRow` return shape is unchanged. For hot list paths this
  is an N+1 risk — the documented optimisation is to **denormalize the user
  display label** (email/displayName/roleSlug) onto the row at write time, so
  reads need zero secondary lookups. We defer that denormalization until a
  profiler says we need it.

### 4.3 Full-text / spotlight search

`searchDataRows` uses `lower(slug) LIKE '%q%'` cross-table. Convex has no `LIKE`
and no built-in trigram FTS, but it does have a **search index**:

```ts
// convex/schema.ts (excerpt)
data_rows: defineTable({ /* … */ slug: v.string(), search_text: v.string(), /* … */ })
  .searchIndex('by_search_text', { searchField: 'search_text', filterFields: ['table_id', 'deleted_at'] })
```

`search_text` is a denormalized, lowercased concatenation of the searchable
cells, written on every `createDataRow`/`saveDataRowDraft`. `searchDataRows`
then uses `ctx.db.query('data_rows').withSearchIndex('by_search_text', q => q.search('search_text', query).eq('deleted_at', null))`.
For the prefix-only `slug` case, a plain `by_slug` index + range works without
the search index. We accept that Convex search is token-based, not substring —
the rare true-substring need falls back to app-side filter over an indexed
slice.

### 4.4 `IN`-list reads and pagination

- **`IN (?, ?, …)`** (`getDataRowMany`, folder hydration) → loop the ids and
  `Promise.all` per-id index lookups (as in §4.2), or a single
  `.filter(q => …)` scan when the id set is large relative to the table. There
  is no clause-length limit to trip over because there is no `IN` clause.

- **`ORDER BY … LIMIT/OFFSET`** → Convex cursor pagination. The
  `LIMIT 50 / LIMIT 100` list queries (`listLoginAttemptsForUser`,
  `listAuditEvents`, `listDataRows`) use `.paginate({ cursor, numItems })` or a
  bounded `.take(n)` on an index ordered by the sort column. The repository
  return type gains an optional `{ page, continueCursor }` only where the
  handler needs more than the first page; fixed-cap feeds keep returning a plain
  array via `.take(n)`.

- **Migration cursors** (`listPendingOriginals` uses `id > cursor`
  lexicographic) → switch to an index on the app id field with a `.gt` range, or
  to Convex's native `_id` cursor. The cross-cutting note flags that nanoid
  lexicographic order ≠ `_id` order; we keep paginating on the **app `id`**
  field (indexed) so ordering semantics are preserved exactly.

### 4.5 App-generated string ids vs Convex `_id`

Every table uses an **app-generated nanoid `id`** (or composite/natural key like
`sessions.id_hash`, `active_media_storage_adapter.role`). These ids are
load-bearing: they appear in cookies (`id_hash`), in cross-table references
without FKs, in export bundles, and in URLs. We **keep them**.

Rule:

- The nanoid `id` stays a normal indexed string field on the document
  (`id: v.string()` + `.index('by_app_id', ['id'])`). It remains the identity
  every repository, handler, and export uses.
- Convex's `_id` is treated as an **internal opaque handle** used only for
  `ctx.db.patch(_id, …)` / `ctx.db.delete(_id)` inside a handler after a lookup
  by app id. It never leaks into return shapes, the REST API, or bundles.
- The schema notes that say `v.id('media_assets')` for cross-references are
  **overridden by this rule**: cross-domain references stay `v.string()` app
  ids, not `v.id(...)`, so that (a) imports can restore arbitrary ids and (b) we
  are not forced to migrate every FK to a Convex document handle. Referential
  integrity is enforced in application code (it already is — there are no real
  FKs at the SQLite layer beyond `PRAGMA foreign_keys`).

Helper used everywhere:

```ts
const byAppId = (ctx, table, id) =>
  ctx.db.query(table).withIndex('by_app_id', (q) => q.eq('id', id)).unique()
```

### 4.6 Upserts (`ON CONFLICT`)

Convex has no `ON CONFLICT`. Every upsert becomes **read-by-index → patch-or-insert**
inside one mutation (atomic, so no TOCTOU within the mutation):

```ts
async function upsertByAppId(ctx, table, id, fields) {
  const existing = await byAppId(ctx, table, id)
  if (existing) { await ctx.db.patch(existing._id, fields); return existing.id }
  await ctx.db.insert(table, { id, ...fields }); return id
}
```

This covers: `createSite`/`saveDraftSite` (`id='default'` singleton),
`upsertUserPreferenceRow` (`(user_id,key)`), `electAdapter` (`role`),
`electVariantDelegate` (`singleton`), `setDefaultForScope` (`scope`),
`importDataRowRedirect` (`(from_route_base,from_slug)`),
`syncSystemRoles` (per-role), `importMediaAsset`/`importMediaFolder`, and the
plugin upserts. The partial-unique constraints
(`users_email_normalized_active_idx WHERE deleted_at IS NULL`,
`data_rows_table_slug_active_idx WHERE deleted_at IS NULL AND slug<>''`) have **no
Convex equivalent** — they are enforced by an explicit pre-write read inside the
mutation: query the index for a live row with the same key, throw the existing
`CredentialError`/duplicate error if found. The reconcile two-phase slug dance
(§3 #9) depends on this and is preserved: park the slug-changing row on `''`,
write the incoming row to the freed slug, then finalize — all inside the single
atomic `dataRows.reconcile` mutation, so no intermediate state is ever observed.

> **Singleton enforcement** (`site` id `'default'`, variant delegate) uses a
> **fixed document id convention**: store under app id `'default'` / `'active'`
> and always upsert by that key — the closest Convex idiom to
> `CHECK (singleton = 1)`.

---

## 5. Auth

**Decision: keep server-managed sessions in a Convex `sessions` table. Do NOT
adopt `@convex-dev/auth`.**

Justification:

- `@convex-dev/auth` assumes the **browser** holds the auth context and calls
  Convex directly with a JWT. Instatic's browser never touches Convex — it talks
  to the Bun server, which owns the `instatic_admin_session` cookie. Adopting
  `@convex-dev/auth` would mean re-architecting the entire request path and
  moving capability checks into Convex, which is exactly the churn this fork is
  trying to avoid.
- Instatic's session model is richer than a stock auth library: SHA-256 token
  hashing (the raw token is never stored), sliding-window idle expiry
  (`last_seen_at > now − 30d`), MFA gating (`mfa_passed_at`), step-up freshness
  (`step_up_expires_at`), device labels, and per-session revoke. All of this is
  already correct SQL logic; we port the *logic*, not replace the *model*.

So the auth port is mechanical:

- `sessions`, `users`, `login_attempts`, `user_preferences`, `roles` become
  Convex tables (§6). The token still lives only in the HTTP-only cookie; only
  its SHA-256 `id_hash` is stored.
- `server/auth/sessions.ts` keeps `createSessionToken()` (still
  `randomBytes(32).toString('base64url')`) and `hashSessionToken()` (still
  SHA-256) **in the Bun server** — crypto stays server-side, not in Convex.
- `findUserBySessionHash(convex, idHash)` becomes a Convex query that looks up
  `sessions` by `id_hash`, applies the live-session predicate
  (`revoked_at===null && expires_at>now && last_seen_at>cutoff`), hand-joins
  `users`+`roles`, enforces `status==='active' && deleted_at===null`, applies
  the MFA gate, and returns `AuthUser` or the `'mfa_required'` sentinel — the
  exact contract `server/auth` already expects.
- The token-rotation transaction (§3 #3) becomes the `sessions.rotate` mutation.

`@convex-dev/auth` is reconsidered only if/when Instatic ever lets the browser
talk to Convex directly — out of scope for this migration.

---

## 6. Schema: `convex/schema.ts` replaces 33 `CREATE TABLE`s

The dialect-paired DDL files (`migrations-sqlite.ts`, `migrations-pg.ts`,
~50 KB each) and the whole migration machinery are replaced by **one declarative
`convex/schema.ts`**. Convex versions and deploys the schema; there is no
`schema_migrations` table and no `runMigrations` at boot.

Mechanical translation rules (the per-domain specs already give
`convexType` for every column):

- `integer` boolean (`0/1`) → `v.boolean()`; coerce on import.
- `*_json` `TEXT` → `v.string()` (opaque blob, parsed in app). **The
  `*_json`-auto-parse convention is gone** — every read site must
  `JSON.parse` explicitly. Searchable scalars get hoisted to real fields
  (§4.2/§4.3).
- `blob` (`ciphertext`, `iv`, `content_bytes`) → base64 `v.string()` for small
  secrets/IVs; `content_bytes` for `published_runtime_assets` uses
  `v.bytes()` only if < ~1 MB, otherwise **Convex File Storage** (the spec flags
  the ~4 MB document limit). Crypto is unchanged: AES-256-GCM with
  `key_fingerprint` rotation detection stays in Bun.
- nullable `TEXT` → `v.union(v.null(), v.string())`.
- Each app id column gets `.index('by_app_id', ['id'])`. Each SQL index becomes
  a Convex `.index(...)` on the same column tuple (dropping the `WHERE` clause,
  which moves to in-handler filtering — §4.6).
- Enum CHECK constraints (`status`, `result`, `step_up_*`, `lifecycle_status`,
  `overlap`) → `v.union(v.literal(...), …)`, validated at the Convex arg
  boundary *and* still at the HTTP boundary via TypeBox.

Sketch (one table, illustrative):

```ts
// convex/schema.ts
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  sessions: defineTable({
    id_hash: v.string(),
    user_id: v.string(),
    created_at: v.string(),
    last_seen_at: v.string(),
    expires_at: v.string(),
    revoked_at: v.union(v.null(), v.string()),
    ip_address: v.union(v.null(), v.string()),
    user_agent: v.union(v.null(), v.string()),
    device_label: v.string(),
    mfa_passed_at: v.union(v.null(), v.string()),
    step_up_expires_at: v.union(v.null(), v.string()),
  })
    .index('by_id_hash', ['id_hash'])
    .index('by_user_last_seen', ['user_id', 'last_seen_at'])
    .index('by_user_active', ['user_id', 'revoked_at', 'expires_at']),
  // … 32 more tables, one per CREATE TABLE …
})
```

---

## 7. Retirement plan

Once **every** repository is ported and green, delete the SQL layer wholesale:

```
server/db/client.ts          ← DbClient interface, placeholder()  → DELETE
server/db/index.ts           ← createDbClient / url parsing        → DELETE
server/db/sqlite.ts          ← bun:sqlite adapter                  → DELETE
server/db/postgres.ts        ← Bun.SQL adapter                     → DELETE
server/db/migrations-sqlite.ts (52 KB DDL)                          → DELETE
server/db/migrations-pg.ts     (49 KB DDL)                          → DELETE
server/db/runMigrations.ts   ← schema_migrations machinery         → DELETE
server/db/advisoryLock.ts    ← pg advisory locks (→ Convex crons)  → DELETE
server/db/jsonExtract.ts     ← json_extract / ->> builder          → DELETE
server/db/__tests__/*        ← SQL-specific tests                  → DELETE
```

Plus: drop `DATABASE_URL` / `isSqliteUrl` / `parseSqlitePath` consumers, the
`bun:sqlite` and Postgres deps, and the `compose.sqlite.yml` / Postgres compose
plumbing. Add `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` to
`.env.example` and the compose files (Convex backend deployed via the
`sc-convex` Dokploy recipe).

The 33 `CREATE TABLE`s now live exclusively in `convex/schema.ts`. The retire
step is **last**: nothing is deleted until the corresponding repository no longer
imports from `server/db`.

---

## 8. Phase order (dependency-aware)

Each phase: write the Convex tables + functions, port that domain's
repositories (signatures frozen), keep the SQL path alive behind the unported
domains until cutover. Phases are ordered so a domain is only ported after the
domains it references.

1. **Identity / auth** — `roles`, `users`, `sessions`, `user_preferences`,
   `login_attempts`, `site` (for setup status). Everything references `users`,
   so it goes first. Port `users.ts`, `roles.ts`, `sessions.ts`,
   `userPreferences.ts`, `loginAttempts.ts`, `setup.ts`, plus
   `server/auth/sessions.ts` write-side. Validate login, MFA, session
   revoke, setup wizard end-to-end. (§5)
2. **Data engine** — `data_tables`, `data_rows`, `data_row_versions`,
   `data_row_redirects`. References `users` (now live). Port the `data/`
   repositories including the heavy `reconcile` and publish transactions
   (§3 #7–12, §4.6). This is the core CMS; biggest surface.
3. **Media** — `media_assets`, `media_folders`, `media_asset_folders`,
   `media_smart_folders`, `media_usage_refs`, `published_runtime_assets`,
   adapter/delegate election tables. References `users` and
   `data_row_versions`. Port `media*.ts`; decide `content_bytes` storage
   (§6 File Storage).
4. **Plugins** — `installed_plugins`, `plugin_records`, `plugin_crash_events`,
   `plugin_schedules`, `plugin_schedule_runs`, `plugin_secrets`. Convert the
   scheduler tick + `tryClaimSchedule` lease to Convex crons + optimistic-lease
   mutation (§4.1). Port `plugins.ts`, `pluginSchedules.ts`, `pluginSecrets.ts`.
5. **AI** — `ai_provider_credentials`, `ai_defaults`, `ai_conversations`,
   `ai_messages`, `ai_model_pricing`. References `users`. Port the
   `appendMessage` denormalized-totals transaction, the JS-side `getUsageByDay`
   bucketing, and the conversation purge cron (§3 #13–16, §4.1).
6. **Site / audit** — `site` (publish side), `site_snapshots`, `audit_events`.
   References `users`/`roles` for label enrichment (hand-join, §4.2). Port
   `site.ts`, `audit.ts`, `publish.ts`'s `persistSitePublish`.
7. **Retire SQL + wire the client everywhere** — delete `server/db/*` (§7),
   swap `runtime.db` to the `ConvexClient` for good, remove the union types,
   drop SQL deps and compose plumbing.
8. **Deploy** — deploy `convex/schema.ts` + functions to the self-hosted Convex
   backend (`sc-convex` recipe on Dokploy), set
   `CONVEX_SELF_HOSTED_URL`/`_ADMIN_KEY`, run the e2e suite against the live
   backend, then ship.

A migration script (separate, one-shot) reads the existing SQLite/Postgres
database and `convex import`s each table preserving app `id`s — run between
phase 7 and 8 for any instance with real data.

---

## 9. Upstream-merge reality

**Stated plainly: this fork can no longer cheaply merge upstream Instatic changes
that touch `server/db/*` or `server/repositories/*` bodies.** Those files are
where we diverge hardest — the entire data layer is rewritten. A `git merge` of
an upstream PR that rewrites a SQL query will conflict with our Convex body, and
the SQL side of the conflict is meaningless to us.

**Mitigation — keep the seam exactly where upstream's does not change:**

1. **Freeze the public repository surface.** Every `server/repositories/*.ts`
   keeps upstream's exported function names, parameter order, and return shapes
   byte-for-byte (this is already §2's core rule). Upstream changes that touch
   **handlers** (`server/handlers/*`), **routing**, **the React UI** (`src/`),
   **validation schemas**, or **business logic above the repository** call those
   frozen functions — so they **merge cleanly**, because we never touched those
   files. Only the repository *bodies* and `server/db` + `convex/` diverge.
2. **Treat `convex/` as additive.** It is a new directory upstream does not
   have, so it never conflicts on merge.
3. **Absorb repository-body conflicts manually.** When upstream changes a
   repository's *behavior* (new column, new filter, changed return field), we
   take the *intent* from their SQL diff and re-implement it in the Convex body
   + `convex/` function. Document each such re-implementation in the repository
   file header so the next merge knows the mapping.
4. **Pin and review.** Track upstream by tag, review each release's diff
   restricted to `server/db` and `server/repositories` (`git log upstream/main
   -- server/db server/repositories`), and port only the behavioral deltas. UI
   and handler deltas flow through untouched.

Net: UI/handler/feature work from upstream stays low-cost to merge; data-layer
work from upstream becomes a manual, intent-level re-port. That is the
deliberate, accepted cost of going native Convex.
```