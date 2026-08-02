# Server

Deep dive on the server-side of Instatic — the Bun process, the router, the handlers, the auth model, the Convex data layer, and how a request becomes a response.

The server is a single `Bun.serve` process that connects to the Convex data layer, syncs system roles, activates installed plugins, then accepts HTTP requests and dispatches them through an ordered route table. There are no other processes, no message queues, no workers. The runtime entrypoint is `server/index.ts`.

---

## TL;DR

- **Entrypoint:** `server/index.ts` (role sync → loop/media adapters → plugin activation → `Bun.serve`). The data layer is Convex, reached through `server/convex/client.ts:getConvex()`.
- **Router:** `server/router.ts` — ordered route table, first-match wins. Each route is a `tryServeX(req, runtime, url, pathname)` function returning `Response | null`.
- **CMS API:** every `/admin/api/cms/*` request goes through `server/handlers/cms/index.ts`, which runs a CSRF origin check and dispatches to per-resource handler groups.
- **Auth:** session cookie (`SESSION_COOKIE_NAME`) → `findUserBySessionHash` → `requireCapability(req, 'site.read')`. Every state-changing handler starts with one of these guards.
- **Data layer:** native, self-hosted Convex. `server/convex/client.ts` exposes one admin-authenticated `ConvexHttpClient` for the whole process (`getConvex()`); the schema lives in `convex/schema.ts` and the query/mutation functions in `convex/*.ts`.
- **Repositories** (`server/repositories/`) are thin pass-throughs: each delegates to a Convex function via `getConvex().query/mutation(api.<domain>.<fn>, args)`. Handlers call repositories and never touch Convex directly.
- **Plugins:** `server/plugins/runtime.ts` activates installed plugins at boot; per-plugin code runs in QuickJS-WASM sandboxes (`server/plugins/quickjs/vm.ts`, `modulePackVm.ts`).
- **Published pages and content rows** are served by `tryServePublicRoute`, which delegates resolution + render to `server/publish/publicRouter.ts`. A warm Layer B cache entry is served before any DB work; on a miss the live render reads the published `SiteDocument` from `site_snapshots` (stored once per publish, referenced by `data_row_versions.site_snapshot_id`, memoised per publish version). Uploads + admin SPA assets are served from disk by `tryServeUpload` and `tryServeStaticAsset`.

---

## Boot sequence

```text
server/index.ts
    │
    ├─→ assert CONVEX_SELF_HOSTED_URL (or CONVEX_URL) is set   ← fail fast: no backend, no boot
    │
    ├─→ readServerConfig()                   ← env vars: PORT, UPLOADS_DIR, STATIC_DIR, PUBLIC_ORIGIN, TRUSTED_PROXY_CIDRS
    │     (the Convex backend URL + admin key are read by getConvex(), not here)
    │
    ├─→ configureTrustedProxyCidrs / configurePublicOrigins
    │
    ├─→ syncSystemRoles()                    ← force-resets Owner capabilities every boot (a Convex data upsert, no DDL)
    ├─→ registerLoopDataAdapter()            ← wire the Convex-backed loop data source
    ├─→ mediaStorageRegistry.configureLocalDisk({ uploadsDir })   ← register local-disk media adapter
    ├─→ activateInstalledServerPlugins(uploadsDir)               ← run plugin lifecycle: activate
    ├─→ startConversationPurgeTick()         ← nightly AI conversation purge
    │
    └─→ Bun.serve({ fetch: req => handleServerRequest(req, runtime) })
```

Boot is sequential and fail-fast. If `CONVEX_SELF_HOSTED_URL` (or `CONVEX_URL`) is unset the process exits before serving — there is no data layer without it. There is no migration step: Convex applies `convex/schema.ts` on deploy, not at boot. If a plugin's `activate` throws, the host logs `[plugin:<id>]` and continues — one bad plugin doesn't bring the server down.

---

## Routing

`server/router.ts` exposes one function:

```ts
export async function handleServerRequest(req: Request, runtime: ServerRuntime): Promise<Response>
```

It walks an ordered `routes` array of `RouteHandler` functions. Each handler returns `Response` (it owns the request) or `null` (try the next handler). The first non-null wins. Unknown paths fall through to a `404`.

### The route table

```ts
const routes: readonly RouteHandler[] = [
  tryServeHealth,                  // /health
  tryServeAi,                      // /admin/api/ai/*         → server/ai/handlers/
  tryServeCmsApi,                  // /admin/api/cms/*        → handlers/cms/index.ts
  tryServeLoopRuntimeAsset,        // /_instatic/loop-runtime.js (fixed CMS asset)
  tryServeLoop,                    // /_instatic/loop/*       → handlers/cms/loop.ts
  tryServeHoleRuntimeAsset,        // /_instatic/hole-runtime.js (fixed CMS asset)
  tryServeHole,                    // /_instatic/hole/*       → handlers/cms/hole.ts
  tryServeModuleJsAsset,           // /_instatic/module-js/*  → handlers/cms/moduleJs.ts
  tryServePublicForm,              // /_instatic/form/*       → forms/handler.ts
  tryServeRuntimeAsset,            // /_instatic/assets/*     → published runtime assets
  tryServeRuntimePackageNamespace, // /_instatic/runtime/cache/<hash>/<...> → bun install workspace
  tryServeSiteCssNamespace,        // /_instatic/css/*        → hashed CSS bundles
  tryServeMediaRedirect,           // /_instatic/media/<adapterId>/<path> → 302 to signed read URL
  tryServeStaticAsset,             // /assets/* → dist/ (admin app)
  tryServeUpload,                  // /uploads/* → uploadsDir (with nosniff hardening)
  tryServeAdminApp,                // /admin/* → dist/index.html (SPA fallback)
  tryServePublicRoute,             // /<slug> OR /<route-base>/<row-slug>
                                   //   → server/publish/publicRouter.ts
                                   //   resolves to page snapshot OR data row + template,
                                   //   live-renders, runs publish.html pipeline
  trySetupRedirect,                // first-run redirect → /admin/setup
  tryServeNotFoundPage,            // fall-through GET → site's 404 page (notFound
                                   //   template; baked 404.html artefact, else live
                                   //   render) with status 404; null → JSON 404
]
```

Order matters. Two examples:

- `tryServeAi` is matched **before** `tryServeCmsApi` so the AI endpoints (`/admin/api/ai/*`) aren't swallowed by the broader CMS dispatcher (`/admin/api/cms/*`).
- `tryServeUpload` is matched **before** `tryServeAdminApp` because `/uploads/...` is a sub-tree the SPA fallback would otherwise consume.

Adding a new endpoint is a one-line edit to `routes` plus a focused `tryServeX` function.

### Exclusive namespaces

Several handlers own an entire prefix and 404 internally rather than falling through:

- `/_instatic/runtime/cache/*` — never falls through to the public-slug renderer
- `/_instatic/css/*` — never falls through
- `/_instatic/media/*` — never falls through

This prevents an unknown path under a known namespace from accidentally matching a later handler.

### Cross-cutting middleware

`Bun.serve.fetch` in `server/index.ts` wraps every request with:

1. **CORS preflight** — `OPTIONS` returns 204 immediately with `corsHeaders(origin)`. ACAO is only set when the request's `Origin` is in `DEV_ORIGIN_ALLOWLIST` (production is same-origin behind Caddy, so no ACAO is needed).
2. **Socket IP stamping** — `stampSocketIp(req, ...)` writes the actual socket peer address onto the request so downstream `clientIp(req)` can ignore spoofed forwarding headers on direct requests. `X-Forwarded-For` is used only when the socket peer matches `TRUSTED_PROXY_CIDRS`; the chain is walked from right to left and the nearest untrusted IP becomes the client IP.
3. **Top-level error catch** — any error that escapes `handleServerRequest` is logged with `console.error('[server] Unhandled request error:', err)` and responded to with a generic `500 Internal server error`. The raw error message is **never** echoed to the client (it can leak internal query fragments, absolute paths, etc.).

`idleTimeout: 0` is set explicitly: the agent endpoint streams NDJSON over Claude's thinking gaps, which can easily exceed Bun's 10s default.

---

## CMS handlers

`/admin/api/cms/*` is handled by `server/handlers/cms/index.ts`. The flow:

1. **CSRF defense in depth.** State-changing methods (`POST/PUT/PATCH/DELETE`) must come from an `Origin` matching a configured public origin (`PUBLIC_ORIGIN`, auto-detected from `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN`), or a dev allowlist entry. With nothing configured the check falls back to the inbound `Host` header. Forwarded headers (`X-Forwarded-Host` / `X-Forwarded-Proto`) are never consulted, so `TRUSTED_PROXY_CIDRS` has no bearing on CSRF. `SameSite=Lax` already covers most CSRF; this catches the same-site-different-subdomain edge.

2. **Group dispatch.** The handler walks an ordered chain of route-group handlers, each owning a resource:

```ts
const response =
  (await handleSetupRoutes(req))
  ?? (await handleAuthRoutes(req))
  ?? (await handleMeRoutes(req, options))
  ?? (await handleUserPreferencesRoutes(req))
  ?? (await handleUsersRoutes(req))
  ?? (await handleRolesRoutes(req))
  ?? (await handleAuditRoutes(req))
  ?? (await handleSiteRoutes(req))
  ?? (await handlePagesRoutes(req))
  ?? (await handleComponentsRoutes(req))
  ?? (await handleRuntimeRoutes(req))
  ?? (await handleMediaFolderRoutes(req))           // before /media/:id
  ?? (await handleMediaStorageAdminRoutes(req, …))  // before /media/:id
  ?? (await handleMediaRoutes(req, …))
  ?? (await handlePluginsRoutes(req, …))
  ?? (await handleDataRoutes(req))
  ?? (await handleDashboardRoutes(req))
  ?? (await handleFontsRoutes(req, …))
  ?? (await handlePublishRoutes(req))
  ?? (await handleExportRoute(req, options))
  ?? (await handleImportPreviewRoute(req))          // before /import (longer path)
  ?? (await handleImportRoute(req, options))
```

Each group module owns its URL matching and returns `Response | null`. The first non-null wins. Order matters — handler order comments in `index.ts` document the load-bearing precedence (e.g. media folder/storage routes must run before `/media/:id` because that pattern would otherwise eat them).

### Route dispatch — `routeTable.ts`

Every handler group uses the shared `runRouteTable` dispatcher from `server/handlers/cms/routeTable.ts` rather than hand-rolling its own `(method, path)` matching. Each group declares a flat `Route[]` table and hands it to `runRouteTable`:

```ts
const PAGES_ROUTES: readonly Route<[]>[] = [
  { method: 'GET', pattern: `${CMS_API_PREFIX}/pages`, handler: handleListPages },
  { method: 'PUT', pattern: `${CMS_API_PREFIX}/pages`, handler: handleUpdatePages },
]

export async function handlePagesRoutes(req: Request): Promise<Response | null> {
  return runRouteTable(req, PAGES_ROUTES)
}
```

`runRouteTable` implements the one correct 404-vs-405 rule in a single place:

- Path matches some route, but no route has the right method → **405 Method Not Allowed**
- No route's pattern matches the path → **`null`**, so the CMS entry point tries the next group and ultimately 404s.

Parameterised routes use a `RegExp` with **named capture groups** (`(?<id>[^/]+)`). The dispatcher decodes each captured value once via `decodeURIComponent`, so handlers receive already-decoded params and never call `decodeURIComponent` themselves.

Handler groups that need per-request context beyond `(req)` (e.g. `CmsHandlerOptions`) pass it as a variadic `...extra` argument through both the route table and the individual handlers:

```ts
// Handler signature — two fixed args (req, params), then the typed extra
async function handleInstallFont(
  req: Request,
  _params: RouteParams,
  options: CmsHandlerOptions,
): Promise<Response> { … }

// Route table — typed with the extra tuple
const FONTS_ROUTES: readonly Route<[CmsHandlerOptions]>[] = [
  { method: 'POST', pattern: `${CMS_API_PREFIX}/fonts/install`, handler: handleInstallFont },
]

export async function handleFontsRoutes(
  req: Request,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  return runRouteTable(req, FONTS_ROUTES, options)
}
```

### Handler shape

Every per-route handler in `server/handlers/cms/` follows the same skeleton:

```ts
async function handleListPages(req: Request, _params: RouteParams): Promise<Response> {
  const user = await requireCapability(req, 'site.read')
  if (user instanceof Response) return user      // 401 / 403 — return early

  const rows = await listDataRows('pages')
  return jsonResponse({ rows })
}

async function handleUpdatePages(
  req: Request,
  _params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, 'site.structure.edit')
  if (user instanceof Response) return user

  const BodySchema = Type.Object({ pages: Type.Array(Type.Unknown()), /* … */ })
  const body = await readValidatedBody(req, BodySchema)
  if (!body) return badRequest('Invalid request body')
  // … mutate via repository, return jsonResponse(…)
}
```

Conventions:

- **Require capability first**, return early on auth failure.
- **Validate body second** via TypeBox.
- **Talk to repositories third.** Handlers don't touch Convex directly.
- **Return `jsonResponse({ … })` or an error envelope last.**
- Path matching and 404/405 discrimination are handled entirely by `runRouteTable` — individual handlers never check `req.method` or `url.pathname`.

---

## HTTP helpers

`server/http.ts` owns the small set of cross-handler helpers:

| Helper                           | Purpose                                                              |
|----------------------------------|----------------------------------------------------------------------|
| `jsonResponse(body, init?)`      | Returns a `Response` with `content-type: application/json`           |
| `readValidatedBody(req, schema)` | Parses the request body and validates it against a TypeBox schema. Returns the typed value on success, `null` on JSON parse failure or schema mismatch. Callers return `badRequest(msg)` on null. |
| `methodNotAllowed()`             | `405` with `{ error: 'Method not allowed' }`                         |
| `badRequest(message)`            | `400` with `{ error: message }`                                      |
| `setCookieHeader(res, value)`    | Appends a `Set-Cookie` header                                        |

`readValidatedBody` is the canonical body parser: it parses JSON and validates the shape against a TypeBox schema in one step, so handlers receive a fully typed value or return `badRequest` immediately.

### Binary helpers (`server/binary.ts`)

`server/binary.ts` provides two helpers for safely handing `Uint8Array` bytes to `Response` bodies and worker `postMessage` transfers:

| Helper                             | Purpose                                                              |
|------------------------------------|----------------------------------------------------------------------|
| `toArrayBuffer(bytes: Uint8Array)` | Copies the view's logical range into a fresh, exactly-sized `ArrayBuffer`. Required because a `Uint8Array` is only a view — its `.buffer` may be larger (pooled or sliced backing store) and resolves to `ArrayBuffer \| SharedArrayBuffer` which transfer/body slots reject. |
| `binaryResponse(bytes, init?)`     | Convenience wrapper: calls `toArrayBuffer` then wraps the result in a `new Response(...)`. Use for every "serve raw bytes" response in route handlers. |

Use `binaryResponse` whenever a route handler returns binary content (runtime assets, CSS bundles, images). Use `toArrayBuffer` when bytes must cross a worker `postMessage` boundary as a transferable.

**Error envelope.** Every CMS handler error returns `{ error: string }` and is validated client-side by `ErrorEnvelopeSchema` in `src/core/http/apiClient.ts` (re-exported from `responseSchemas.ts`). The canonical client `apiRequest` (and `readEnvelope`) extract the message via `responseErrorMessage(res, fallback)` and throw an `ApiError` carrying the HTTP status.

---

## Auth and capabilities

`server/auth/` owns the entire authentication surface.

| File              | Owns                                                                       |
|-------------------|----------------------------------------------------------------------------|
| `tokens.ts`       | Session cookie name, token hashing                                         |
| `sessions.ts`     | Session lookup, MFA gate, step-up timer                                    |
| `authz.ts`        | `requireAuthenticatedUser`, `requireCapability`, `requireAnyCapability`    |
| `capabilities.ts` | `CoreCapability` enum and per-capability membership rules                  |
| `lockout.ts`      | Failed-login lockout policy                                                |
| `mfa.ts`          | TOTP enrollment, verification                                              |
| `rateLimit.ts`    | Token-bucket rate limiters                                                 |
| `security.ts`     | `isStateChangingMethod`, `originAllowed`, `configurePublicOrigins`, `DEV_ORIGIN_ALLOWLIST`, IP stamp |
| `deviceLabel.ts`  | Device-fingerprint label for the sessions panel                            |

### The session flow

```text
Cookie: instatic_admin_session=<token>
    │
    ▼
hashSessionToken(token)
    │
    ▼
findUserBySessionHash(idHash)
    │
    ├─→ no row              → 401 Unauthorized
    ├─→ row but MFA needed  → 401 { error: 'mfa_required' }
    └─→ row OK              → AuthUser { id, email, capabilities, ... }
```

`findUserBySessionHash` hydrates the `AuthUser` with a single Convex query
(`api.sessions.findUserRowBySessionHash`) that looks the session up by
`id_hash`, applies the live-session predicate, and hand-joins `users` + `roles`.
It then touches `sessions.last_seen_at` (`api.sessions.touchLastSeen`), but that
write is **debounced** to at most once per session per ~30s via an in-memory
tracker — the idle timeout is 30 days, so up-to-30s staleness is irrelevant, and
the hot per-request write is gone.

**Resolve the session once per request.** A handler calls exactly one of
`requireAuthenticatedUser` / `requireCapability` / `requireAnyCapability` to get
its `AuthUser`, then reuses that value for any further checks. Additional
capability checks in the same handler use the pure `userHasCapability(user, …)`
predicate rather than calling another guard, and the step-up gate takes the
already-resolved user (see below). No handler should hydrate the session twice.

### The capability gate

```ts
const user = await requireCapability(req, 'site.read')
if (user instanceof Response) return user   // 401 or 403 already encoded
// ... user is now AuthUser
```

`requireCapability` and `requireAnyCapability` are the only auth surfaces a handler should call. Capabilities are strings like `site.read`, `site.structure.edit`, `media.write`, `plugins.install`, `users.manage`, etc. Owner accounts get all `CORE_CAPABILITIES` automatically. The full list is in `src/core/capabilities.ts` (`@core/capabilities`); `docs/reference/capabilities.md` catalogs every one.

### Step-up auth

Sensitive actions (delete user, revoke another device, sign out all devices) gate on `requireStepUp(req, user, options?)`. It takes the **already-resolved `AuthUser`** — it does NOT re-authenticate — and returns `Response | null`: a 401 `{ error: 'step_up_required' }` when the window is stale, or `null` to proceed. The canonical pattern is therefore:

```ts
const user = await requireCapability(req, 'users.manage')
if (user instanceof Response) return user
const stepUp = await requireStepUp(req, user)
if (stepUp) return stepUp
// ... re-authenticated, proceed with `user`
```

This is what keeps a capability-gated sensitive write to one session lookup: the capability guard hydrates the session once, and `requireStepUp` only reads `step_up_expires_at` for that session. (Handlers with no preceding capability guard — e.g. the `/me/*` security routes — call `requireAuthenticatedUser` first to obtain `user`.)

Step-up is required by default with a 15-minute window, can be configured per user from Account -> Security, and can be disabled per user. The expiry lives on the session row as `step_up_expires_at` and is refreshed by `POST /admin/api/cms/auth/step-up`.

---

## Repositories

All data access lives in `server/repositories/`. Each file owns one resource and delegates to the matching `convex/*.ts` functions:

| File                       | Owns                                              |
|----------------------------|---------------------------------------------------|
| `audit.ts`                 | Audit log writes and queries                      |
| `data/`                    | `data_tables` + `data_rows` (the universal store) |
| `fonts.ts`                 | Font assets                                       |
| `loginAttempts.ts`         | Failed-login records for lockout                  |
| `media.ts`                 | Media assets                                      |
| `mediaFolders.ts`          | Folder tree for media                             |
| `mediaMigration.ts`        | Migration of media between storage adapters      |
| `mediaStorageAdapters.ts`  | Registered storage backends                       |
| `pluginSchedules.ts`       | Plugin-registered scheduled jobs                  |
| `plugins.ts`               | Installed plugins + lifecycle state               |
| `publish.ts`               | Published-page roster: snapshot getters + the transactional publish write (orchestration lives in `server/publish/publishSite.ts`) |
| `roles.ts`                 | System and custom roles                           |
| `runtimeAsset.ts`          | Published runtime assets (JS, CSS, fonts)         |
| `sessions.ts`              | User sessions                                     |
| `setup.ts`                 | Setup wizard state (`isSetup`, first-run owner)   |
| `site.ts`                  | The single site shell row                         |
| `userPreferences.ts`       | Per-user editor preferences                       |
| `users.ts`                 | Users + auth fields                               |

### Repository rules

1. **Repositories are thin pass-throughs.** Each function keeps a frozen signature and delegates to a Convex function via `getConvex().query/mutation(api.<domain>.<fn>, args)`. Ownership checks, soft-delete filters, read-before-write upserts, and hand-assembled joins live in the `convex/*.ts` function, not the repository. See [docs/reference/database-dialects.md](reference/database-dialects.md).

2. **App ids use the `by_app_id` index.** The app-generated nanoid `id` is an indexed `v.string()`; Convex's `_id` stays an internal handle used only for `ctx.db.patch`/`delete` after a by-app-id lookup. Cross-table references are `v.string()` app ids, never `v.id(...)`.

3. **`*_json` columns stay opaque strings.** A `*_json` field is `v.string()`, `JSON.parse`d explicitly at every read site — there is no auto-parse. Scalars you filter, sort, or search on are hoisted to their own indexed fields.

4. **Validate persisted JSON.** Anything read from a `*_json` field passes through a TypeBox schema (e.g. `validateSite` for the site shell) before a repository returns it. Stored data is not a trusted source.

5. **Mutations are atomic.** A Convex mutation is a transaction over every document it touches — a multi-row write (token rotation, import replace-all, publish, reconcile) is one mutation, and a crash mid-handler rolls it all back. There is no `BEGIN/COMMIT`; the handler is the transaction.

---

## The Convex client

`server/convex/client.ts` owns the single server→Convex handle:

```ts
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../convex/_generated/api'

// One long-lived client per server process, authenticated with the self-hosted
// ADMIN key. The Bun server is a fully trusted backend — every capability check
// already ran in the HTTP handler before we get here — so it invokes Convex
// functions with admin privileges. User identity is NOT carried on this
// channel; it is passed as explicit function args.
export function getConvex(): ConvexHttpClient { /* … */ }
export { api }
```

Repositories import `{ getConvex, api }` and delegate:

```ts
const rows = await getConvex().query(api.sessions.listForUser, { userId })
const ok   = await getConvex().mutation(api.sessions.revokeByHashForUser, { sessionHash, userId })
```

Three properties of the channel:

- **Admin auth, identity as data.** The client authenticates with the self-hosted admin key (`CONVEX_SELF_HOSTED_ADMIN_KEY`), so it can invoke any function. The acting user is a validated **argument** (`userId`, `actorUserId`) — never `ctx.auth.getUserIdentity()`. The browser never holds a Convex token.
- **App ids, not `_id`.** Every table stores its app-generated nanoid `id` as an indexed `v.string()`, looked up via the `by_app_id` index. Convex's `_id` is an opaque internal handle used only for `ctx.db.patch`/`delete` after a by-app-id lookup, and never leaves the handler.
- **`*_json` stays a string.** JSON blobs are `v.string()`, parsed explicitly in app code. Scalars that get filtered, sorted, or searched are hoisted to real indexed fields.

### Schema

`convex/schema.ts` is the single declarative schema — every table, field, and index. Convex versions it and applies changes on **deploy**; there is no `_migrations` table, no migration files, and no DDL at boot. Adding or changing a table means editing `convex/schema.ts` and the matching `convex/*.ts` functions. See [docs/reference/database-dialects.md](reference/database-dialects.md) and [docs/CONVEX-MIGRATION.md](CONVEX-MIGRATION.md).

### Atomic mutations

A Convex mutation is atomic over every document it touches — the whole handler is the transaction, with no `BEGIN/COMMIT`. Multi-row writes that must be consistent (token rotation, the import replace/merge family, site + row publish, the `data_rows` reconcile) each collapse into one mutation; a crash mid-handler rolls the whole thing back. The risk to watch is the size/time limit of a single mutation — very large batch writes are chunked into a coordinator action that calls many small mutations. See [docs/CONVEX-MIGRATION.md §3](CONVEX-MIGRATION.md).

### Scheduled work and leases

Recurring background work — the plugin schedule tick (`server/plugins/scheduler.ts`) and the AI conversation purge (`startConversationPurgeTick`) — runs as an in-process `setInterval` loop. Where two instances must not double-fire the same job, the lease is an **atomic Convex mutation** (`tryClaimSchedule`) using optimistic concurrency: because the mutation is atomic, two concurrent claimants serialise — the loser sees the live lease and no-ops. See [docs/CONVEX-MIGRATION.md §4.1](CONVEX-MIGRATION.md).

---

## Publishing pipeline

Three-layer model: **static-by-default, dynamic-by-auto-detection**.

- **Layer A — static-to-disk.** **Every** page is baked at publish time. A fully-static page (no dynamic modules, no request-dependent bindings/loop sources, no VC refs to dynamic VCs) bakes a complete document; a page with dynamic nodes bakes its static **shell** with `<instatic-hole>` placeholders (the dynamic nodes are Layer C holes). HTML is written to `uploads/published/current/<route>.html`, and the CSS bundles (`/_instatic/css/…`) and runtime JS (`/_instatic/assets/…`) are baked into the same slot. The visitor router reads all of these directly off disk (`readArtefact` / `readStaticAsset`) — **a published page never touches the DB for HTML, CSS, or JS.** TTFB ≤ 1.5 ms.
- **Layer B — in-memory LRU.** Requests that vary by query string (loops with `?page=N`, request-dependent bindings) bypass the disk fast-path and render live, memoised by `(urlPath, queryString)`. Single-flight. Every publish bumps `publishVersion` so the entire cache evicts lazily. The version is captured at render start — if a publish lands before the factory resolves, the result is returned to the caller but not stored; the next request re-renders against the fresh snapshot.
- **Layer C — server islands ("holes").** When `findDynamicNodeIds(...)` classifies a node as dynamic (module flagged `dynamic: true`, or its bindings/loop source declare `requestDependent: true`, or it's a VC ref to a dynamic VC), the publisher emits a `<instatic-hole>` placeholder with an optional `staticPlaceholder(props)` skeleton. A ~668 B `IntersectionObserver` runtime fetches `/_instatic/hole/<nodeId>?v=<publishVersion>` lazily as the placeholder enters the viewport. **The hole fragment is the only request that reads the DB for an otherwise-static page.** Hole responses are cached via Layer B's LRU.

Authors don't toggle anything. `src/core/publisher/dynamicDetection.ts:findDynamicNodeIds` is backed by the single walker that powers Layer A's shell-vs-complete bake and Layer C's placeholder emission. The rules live in exactly one file.

```text
                            on publish
                                ↓
            publishDraftSite / publishDataRow
                                │
              ├── write SiteDocument once → site_snapshots
              │     (page versions reference it via site_snapshot_id)
              ├── for each page (complete doc, or static shell with <instatic-hole>):
              │     publishPage + applyPublishedHtmlPipeline
              │     writeArtefact(inactiveSlot, urlPath, html)
              ├── bake every published data-row route into the same slot
              │     (bakeDataRows.ts — entry-template render, same pipeline)
              ├── bake CSS bundles + runtime JS → writeStaticAsset(inactiveSlot)
              ├── swapSlot — atomic symlink rename of uploads/published/current
              └── bumpPublishVersion() — Layer B cache evicts lazily

                          on visitor request
                                ↓
            server/router.ts → tryServePublicRoute
                                ↓
                  renderPublicResolution(db, url, uploadsDir)
                                │
       ┌────────────────────────┼────────────────────────────┐
       ▼                        ▼                            ▼
  Layer A disk           resolvePublicRoute             (page contains holes)
  readArtefact            page / row / redirect          /_instatic/hole/<id>?v=<ver>
  (only if no ?           / not-found                    handled by
  query string)                  │                       server/handlers/cms/hole.ts
       │                  ┌──────┴───────┐                     │
   hit → stream    redirect → 301  page/row → Layer B          ▼
                                          getOrRender         render one node
                                          (LRU + single-      cached in Layer B
                                           flight + version)
```

Server-side publishing helpers live in `server/publish/`:

| File                              | Role                                                                |
|-----------------------------------|---------------------------------------------------------------------|
| `publicRouter.ts`                 | Visitor URL → resolution → Response. Composes Layer A disk-read + Layer B cache. Single entry for every visitor HTML request. |
| `staticArtefact.ts`               | Layer A. Two-slot symlink swap (`current → slot-{a,b}`), atomic per-file `tmp + rename`, slot-aware read/write/purge. |
| `renderCache.ts`                  | Layer B. Bounded LRU keyed by `(urlPath, queryString)`, entries versioned. Single-flight on cache miss. `bumpPublishVersion()` invalidates lazily; version captured at render start so mid-flight publishes discard without caching stale HTML. |
| `holeRuntime.ts`                  | Layer C client-side runtime (~668 B). Exports `runInstaticHoleRuntime` (TS source) and `HOLE_RUNTIME_JS` (IIFE-serialized for browser delivery). |
| `publishSite.ts`                  | Full-site publish orchestrator (`publishDraftSite`): phase-1 builds, the short `persistSitePublish` transaction, Layer A bake + slot swap, Layer B bump. |
| `publishRow.ts`                   | Per-row publish orchestrator (`publishDataRow`) + `removeDataRowArtefact`: persist via the data repository, in-place artefact update, Layer B bump. |
| `publicRenderer.ts`               | `renderPublishedSnapshot`, `renderPublishedDataRowTemplate` — snapshot-aware wrappers around `publishPage`. |
| `publishedHtmlPipeline.ts`        | Plugin frontend-asset injection + `publish.html` filter chain. Runs at publish time for every baked page (complete doc or hole shell); also runs in the Layer B factory for query-string / live renders (cached). |
| `siteCssBundle.ts`                | Per-site reset / framework / style CSS bundles (hashed filenames).  |
| `republish.ts`                    | Bulk re-publish (after a settings change touches all pages).        |
| `publishScheduler.ts`             | Scheduled publish jobs.                                             |
| `frontendInjections.ts`           | Plugin-contributed frontend scripts injected into published HTML.   |
| `mediaPresentation.ts`            | `<picture>` / `<img srcset>` materialization at publish time.       |
| `mediaPrefetch.ts`, `loopPrefetch.ts` | Pre-warm caches needed by published pages.                      |
| `runtime/packageServer.ts`        | Serve per-site `bun install` workspace under `/_instatic/runtime/cache/`. |

Plus the hole endpoint at `server/handlers/cms/hole.ts` — registered in the router BEFORE `tryServePublicRoute` so `/_instatic/hole/*` requests never fall through to slug resolution.

Published pages are HTML + a single hashed CSS bundle per page. The ONLY first-party client script is the Layer C hole runtime, and it's injected ONLY on pages that contain at least one `<instatic-hole>`. Fully-static pages ship zero JS from us. Plugins can inject frontend assets explicitly via `frontendInjections.ts`.

For the full design including invariants, atomic-publish protocol, and the auto-detection rules, see [docs/features/publisher.md](features/publisher.md).

---

## Plugin runtime

Plugins ship as zip packages with a `plugin.json` manifest. The host:

1. **Installs** the package (unzips into `uploads/plugins/<id>/<version>/`) — `server/plugins/package.ts`.
2. **Validates** the manifest and scans the bundled JS for forbidden sandbox-incompatible patterns — `assertSandboxSafe` in `package.ts` + `parsePluginManifest` in `src/core/plugins/manifest.ts`.
3. **Activates** the plugin at boot or on user action — `server/plugins/runtime.ts`. Activation loads the server entrypoint into a per-plugin QuickJS-WASM VM (`server/plugins/quickjs/vm.ts`) and runs its `activate(api)` lifecycle hook.
4. **Routes** plugin-registered HTTP routes through `/admin/api/cms/plugins/<id>/runtime/…` (handled by `handleRuntimeRoutes`).
5. **Brokers** the SDK boundary — `api.cms.routes.*`, `api.cms.storage.*`, `api.cms.hooks.*`, `api.cms.loops.*`, `api.cms.settings.*`, `api.cms.schedule.*`. The SDK shape is defined in `src/core/plugin-sdk/`.

The sandbox has **no host access** — no Node, no Bun, no file system, no env vars, no network unless `network.outbound` permission + `networkAllowedHosts` allowlist is granted.

Sandbox invariants are gated by `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`. Module-pack VMs (canvas-side plugin modules) run in `modulePackVm.ts`.

See [docs/features/plugin-system.md](features/plugin-system.md) for the full feature doc.

---

## Static serving

Three static handlers, in order:

| Handler                | Owns                                                                  |
|------------------------|-----------------------------------------------------------------------|
| `tryServeStaticAsset`  | `/assets/*` from `dist/` (Vite-built admin SPA assets)                |
| `tryServeUpload`       | `/uploads/*` from `uploadsDir` with `hardenUploadResponse` (nosniff, attachment for non-inert MIMEs, CORS for plugin bundles) |
| `tryServeAdminApp`     | `/admin/*` — serves the admin shell from `dist/index.html` with path-specific injections (see below) |

`server/static.ts` owns all three. Key behaviors:

- **Range requests** are honored for media (`Range: bytes=...`).
- **Conditional GET** via `If-None-Match` / `If-Modified-Since` is honored.
- **MIME-type allowlist** (`INERT_UPLOAD_MIMES`) — non-allowlisted uploads get `Content-Disposition: attachment` so they can't be top-level navigated and rendered as HTML on the admin origin.
- **Plugin bundles** (`/uploads/plugins/*`) get `Access-Control-Allow-Origin: *` because the editor preview iframe loads them from an opaque origin (`sandbox="allow-scripts"` without `allow-same-origin`).
- **Admin shell path-specific serving** (`serveAdminApp`): the two visitor paths inject different content into the shell HTML to minimize perceived load time:
  - **Unauthenticated** (no session cookie): injects a styled login skeleton into `<div id="root">` and a `BOOT_API_KICKOFF` inline script that fires `setupStatus`, `/me`, and `publicSite` fetches at HTML-parse time. FCP shifts from ~400 ms (React mount) to ~DCL (~50 ms), and `useAdminBoot` finds pre-resolved promises instead of waiting for `useEffect`.
  - **Authenticated**: keeps the existing spinner shell, but injects `BOOT_API_KICKOFF`, an `__instaticAuthed = 1` flag (lets `main.tsx` skip the post-Suspense concurrent re-render delay), and `<link rel="modulepreload">` hints for the authenticated shell chunk (`AuthenticatedAdmin-*.js`). Only the shell chunk is preloaded here; workspace-page pre-warming is handled in `AuthenticatedAdmin` via `requestIdleCallback` after first paint.

---

## Adding a new endpoint

1. **Pick the right layer.**
   - CMS resource (e.g. `/admin/api/cms/feature`) → new handler file in `server/handlers/cms/feature.ts`, register in `server/handlers/cms/index.ts`.
   - Top-level (e.g. `/_instatic/something`) → new `tryServeX` in `server/router.ts`, add to the `routes` array in the right order.

2. **Write the handler.** Require capability → validate body → call repository → return `jsonResponse`. One function per route. Add a `Route` entry to the group's `ROUTES` table; path matching and 404/405 discrimination are handled by `runRouteTable` — do not hand-roll `if (url.pathname !== ...)` or `return methodNotAllowed()` in the handler itself. Parameterised paths use a `RegExp` with named capture groups; the dispatcher decodes each captured value once.

3. **If new data access is needed,** add the function to the matching `server/repositories/<resource>.ts` (it delegates to a `convex/*.ts` function via `getConvex()`). The handler never calls Convex itself.

4. **If a new persisted shape is involved,** add or change the table in `convex/schema.ts` and the matching `convex/*.ts` functions; Convex applies it on deploy. JSON columns end in `_json` and are parsed explicitly.

5. **If client-side calls the endpoint,** add a TypeBox response schema (in `src/core/persistence/responseSchemas.ts` for CMS endpoints, or alongside the caller) and fetch via the canonical `apiRequest(path, { schema })` from `@core/http`. Persistence-layer functions that inject their own `fetch` validate via `readEnvelope`.

---

## Adding a new repository

1. Create `server/repositories/<resource>.ts`. Export typed functions: `listX`, `getX(id)`, `createX(...)`, `updateX(id, patch)`, `deleteX(id)`.
2. Keep each function a thin pass-through — delegate to a `convex/<resource>.ts` query/mutation via `getConvex().query/mutation(api.<resource>.<fn>, args)`. Put the logic (guards, joins, upserts) in the Convex function.
3. JSON columns end in `_json` and stay `v.string()`; parse them explicitly. Multi-row writes that must be atomic are a single Convex mutation.
4. Look rows up by app id through the `by_app_id` index; never expose Convex `_id`.
5. Validate any persisted JSON with a TypeBox schema before returning it.

---

## Error handling

- **Server logs** use the prefix `console.error('[<module>]', err)` — e.g. `'[router] adapter "<id>" getReadUrl failed:'`, `'[server] Unhandled request error:'`.
- **Domain errors** are typed `Error` subclasses with a `path` (or similar) field — e.g. `SiteValidationError`, `VisualComponentNameError`. Add a typed class when callers need to distinguish causes.
- **Generic `throw new Error(...)`** is fine for "this should never happen" invariants.
- **Never echo raw error messages to the client.** The top-level catch in `server/index.ts` returns a generic 500. Handlers return `{ error: <safe message> }`.
- **`catch (err)` → client error string:** use `getErrorMessage(err, 'fallback message')` from `src/core/utils/errorMessage.ts`. The hand-rolled `err instanceof Error ? err.message : 'fallback'` pattern is forbidden because it surfaces a blank string for `new Error('')` — `getErrorMessage` falls back when the message is empty or whitespace-only.

See [docs/reference/typebox-patterns.md](reference/typebox-patterns.md) for boundary validation patterns.

---

## Related

- [docs/architecture.md](architecture.md) — system overview
- [docs/editor.md](editor.md) — what the admin / editor frontends do
- [docs/features/plugin-system.md](features/plugin-system.md) — plugin runtime details
- [docs/reference/database-dialects.md](reference/database-dialects.md) — the data layer (Convex)
- [docs/CONVEX-MIGRATION.md](CONVEX-MIGRATION.md) — full data-layer architecture
- [docs/reference/typebox-patterns.md](reference/typebox-patterns.md) — boundary validation
- Source-of-truth files:
  - `server/index.ts` — entrypoint and boot
  - `server/router.ts` — request dispatch
  - `server/http.ts` — JSON / error HTTP helpers
  - `server/binary.ts` — binary response helpers (`toArrayBuffer`, `binaryResponse`)
  - `src/core/utils/errorMessage.ts` — `getErrorMessage(err, fallback)` canonical catch-block extractor
  - `server/handlers/cms/index.ts` — CMS dispatcher
  - `server/handlers/cms/routeTable.ts` — shared `runRouteTable` dispatcher (404-vs-405 rule, named param decoding)
  - `server/auth/authz.ts` — `requireCapability` and friends
  - `server/convex/client.ts` — `getConvex()` + `api` (admin-authenticated Convex handle)
  - `convex/schema.ts` — every table, field, and index
  - `convex/*.ts` — per-domain query/mutation functions
  - `server/repositories/*.ts` — thin pass-throughs with frozen signatures
- Gate tests:
  - `src/__tests__/architecture/cms-handlers-capability-gated.test.ts` — every file under `server/handlers/cms/` calls an auth guard; allowlist entries carry explicit justifications
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
  - `src/__tests__/architecture/ai-driver-isolation.test.ts`
  - `src/__tests__/architecture/plugin-sandbox-invariants.test.ts`
  - `src/__tests__/server/routeTable.test.ts` — unit coverage of `runRouteTable`: dispatch, named params, 405 vs null, extra context forwarding, real-world patterns (data rows, plugins)
