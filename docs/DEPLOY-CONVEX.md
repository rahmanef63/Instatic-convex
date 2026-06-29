# Deploying Instatic on self-hosted Convex + Dokploy

Scaffold for moving the Instatic CMS data layer onto a **self-hosted Convex**
backend and serving the app from **Dokploy** at `instatic-rahmanef.com`.

> **STATUS: SCAFFOLD ONLY — NOT WIRED, NOT DEPLOYED.**
> The Convex data-layer rewrite is in progress (`docs/CONVEX-MIGRATION.md`,
> `convex/schema.ts`). The Instatic Bun server still reads/writes its own
> SQLite/Postgres repositories. **The live-deploy step (C) is BLOCKED** until the
> server actually talks to Convex. See [Blocking gate](#blocking-gate) below.
> Steps A and B (stand up the backend, push the schema) are safe to run early —
> they only create an empty Convex instance and its tables.

---

## Topology

Two independently-deployed halves on the same Dokploy + Traefik:

| Half | Source | Serves | Domain(s) |
|---|---|---|---|
| **Convex backend** | `convex/compose.selfhosted.yml` | data layer | `api-` / `site-` / `dash-instatic-rahmanef.com` |
| **Instatic app** | repo-root `Dockerfile` (Bun + Vite custom server) | the CMS | `instatic-rahmanef.com` |

The app is the Convex **client** — but only on its server side. The Bun server
connects to `https://api-instatic-rahmanef.com` server-side. The React admin
bundle never connects to Convex from the browser; it calls the Bun server's REST
API (`/admin/api/...`), and the server talks to Convex on its behalf.

```
                 ┌───────────────────────── Dokploy host ──────────────────────────┐
  instatic-rahmanef.com ─► Traefik ─► instatic app  (Bun :3001, repo Dockerfile)    │
                                          │  (Convex client — server-side only)      │
  api-instatic-rahmanef.com  ─► Traefik ─►│                                          │
  site-instatic-rahmanef.com ─► Traefik ─►├─► convex backend  :3210 / :3211          │
  dash-instatic-rahmanef.com ─► Traefik ─►└─► convex dashboard :6791                 │
                                              └── volume: instatic_convex_data ◄── DATA
                 └──────────────────────────────────────────────────────────────────┘
```

---

## A. Deploy the Convex backend

Canonical path is the `/sc-convex` skill, which deploys the backend compose on
Dokploy, binds the three subdomains, sets `INSTANCE_SECRET`, and generates +
saves the admin key. It is **idempotent** — re-running updates in place and
preserves `INSTANCE_SECRET` (so it never orphans the data volume).

```bash
# Stand up (or update) the self-hosted Convex backend for this project.
# --domain root.tld → the skill derives api- / site- / dash- subdomains.
# --with-auth-keys  → only if/when the migration adopts @convex-dev/auth
#                     (Instatic currently has its own auth — omit for now).
node ~/.claude/skills/sc-convex/scripts/deploy-convex.js \
  --project instatic \
  --app instatic \
  --domain instatic-rahmanef.com
```

What it sets on the Convex compose env (Dokploy-side, **not** in any repo file):

| Var | Why |
|---|---|
| `INSTANCE_SECRET` | derives the admin key; **preserved across redeploys** |
| `INSTANCE_NAME` | `instatic` |
| `CONVEX_CLOUD_ORIGIN` | `https://api-instatic-rahmanef.com` |
| `CONVEX_SITE_ORIGIN` | `https://site-instatic-rahmanef.com` |
| `CONVEX_ADMIN_KEY` | generated from the running container post-boot |

> `convex/compose.selfhosted.yml` in this repo is the **self-contained
> reference** of that backend (named volume + ports + Traefik labels for the
> three subdomains). The skill deploys Dokploy's built-in `convex` template and
> patches `restart: unless-stopped` per service; the committed file documents the
> exact shape and is what you paste into Dokploy if you deploy the compose by
> hand instead of via the template. Keep the two in sync (image pin, volume name,
> origins). If you deploy the committed compose directly, the in-file Traefik
> labels already bind the three subdomains — do **not** then also add Dokploy
> "Domains" for the same hosts or you get duplicate Traefik routers.

Verify the three subdomains are live:

```bash
node ~/.claude/skills/sc-convex/scripts/check-backend.js \
  --domain instatic-rahmanef.com
# probes api-/site-/dash- + /version + admin-key validity
```

### Pull the backend connection into local env

After step A, record the connection in `.env.local` (gitignored) so the Convex
CLI and local Bun server can reach the backend:

```bash
# .env.local  (NEVER commit)
CONVEX_SELF_HOSTED_URL=https://api-instatic-rahmanef.com
CONVEX_SELF_HOSTED_ADMIN_KEY=<admin key from deploy-convex.js / rotate-admin-key.js>
```

Convex CLI v1.27+ auto-detects a self-hosted backend from these two vars — no
`--url` flags needed.

---

## B. Push the schema

`convex/schema.ts` already exists. Pushing it creates the tables on the
(empty) backend. This is **non-destructive** to an existing populated volume —
Convex applies the schema, it does not wipe rows.

The `/sc-convex` deploy step pushes the schema automatically when
`convex/schema.ts` is present **and** `--domain` was supplied (it calls
`deploySchema({ apiDomain, adminKey })` internally). So step A already pushed it.

To push again after a schema edit, **do not** ask anyone to run `npx convex
deploy` by hand — that path is owned by the sc-git pre-push hook. Per the user's
auto-ship flow: any change under `convex/` triggers the pre-push hook to source
`.env.local` and run `convex deploy` before the push lands. If the hook is
missing, install it instead of running the CLI manually:

```bash
node ~/.claude/skills/sc-git/scripts/hook.js install --repo Instatic-convex
```

> Note: `convex/_generated` must be committed (the skill never runs codegen in a
> Dockerfile). Generate locally with `npx convex dev --once` and commit the
> folder before the first app build that imports the generated API.

---

## C. Build + deploy the Instatic app on Dokploy

> **BLOCKED — do not run until the data-layer rewrite is functional.** See
> [Blocking gate](#blocking-gate).

The app deploy is **not** the stock `/sc-all` Next.js flow. `/sc-all` assumes
Next.js (`next build`, `NEXT_PUBLIC_CONVEX_URL` inlined at build, standalone
output). **Instatic is Bun + Vite + a hand-written `Bun.serve` server** — none of
those assumptions hold. Use `/sc-dokploy` directly for the app and treat the
Convex backend (step A) as already standing.

### Bun/Vite differences from sc-all's Next.js assumptions

| sc-all (Next.js) assumes | Instatic reality |
|---|---|
| `next build` + standalone output | `bun run build` = `tsc -b && vite build` → `dist/`, run by `bun run server/index.ts` |
| `NEXT_PUBLIC_CONVEX_URL` inlined into the browser JS at build | No Convex URL is ever inlined into the browser bundle. The React admin client calls the Bun server's REST API; only the server reads `CONVEX_SELF_HOSTED_URL` (plain runtime env, `CONVEX_URL` fallback) |
| Public URL baked into JS at build, consumed by the browser | One Convex consumer: the server-side Bun process, reading the URL + admin key as runtime env. The browser never connects to Convex |
| `CONVEX_DEPLOY_KEY` for Convex Cloud | self-hosted → `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` |

### Env the app needs (server runtime only)

All Convex config is **server-side runtime env** on the Dokploy app (read by
`server/`). The browser never connects to Convex — it calls the Bun server's REST
API (`apiRequest` → `/admin/api/...`), and the server talks to Convex. **None of
these are build args**; they are supplied at `docker run` / compose `environment:`
time.

| Var | Value | Notes |
|---|---|---|
| `CONVEX_SELF_HOSTED_URL` | `https://api-instatic-rahmanef.com` | server→Convex connection (`CONVEX_URL` is the fallback). **Not** `NEXT_PUBLIC_*` / `VITE_*` — server-side Bun runtime env |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | `<admin key>` | privileged server access. Dokploy env secret, never in the image |
| `PORT` | `3001` | already the Dockerfile default |
| `PUBLIC_ORIGIN` | `https://instatic-rahmanef.com` | CSRF origin (Traefik terminates TLS, app sees plain HTTP) |
| `TRUSTED_PROXY_CIDRS` | `172.16.0.0/12` | trust the Docker bridge X-Forwarded-For (attribution only) |
| `INSTATIC_SECRET_KEY` | `<from generate-secret-key>` | AI-credential encryption (existing app secret) |

> The browser bundle needs no Convex env at all — Vite inlines nothing about
> Convex. The React admin client reaches the data layer purely through the Bun
> server's REST API, so the Convex URL + admin key live only as server runtime
> env. The Dockerfile takes no Convex build arg.

### Deploy command (when unblocked)

```bash
# App half only — the Convex backend already stands from step A.
node ~/.claude/skills/sc-dokploy/scripts/<deploy-app>.js \
  --project instatic \
  --app instatic-app \
  --domain instatic-rahmanef.com \
  --port 3001 \
  --env CONVEX_SELF_HOSTED_URL=https://api-instatic-rahmanef.com \
  --env-secret CONVEX_SELF_HOSTED_ADMIN_KEY \
  --env-secret INSTATIC_SECRET_KEY \
  --env PUBLIC_ORIGIN=https://instatic-rahmanef.com \
  --env TRUSTED_PROXY_CIDRS=172.16.0.0/12
```

(Confirm exact `/sc-dokploy` script + flag names against that skill before
running — the surface above is the intended binding, not a verified invocation.)

After deploy, push to `main` is the trigger: Dokploy's git webhook auto-builds.
No GitHub Action is consumed.

---

## Blocking gate

Step **C is BLOCKED**. The Instatic Bun server still reads/writes its own
`server/db` SQLite/Postgres repositories — it does **not** call Convex yet.
Deploying the app now would ship a CMS that ignores the Convex backend entirely.

Unblock criteria (tracked in `docs/CONVEX-MIGRATION.md`):

1. `server/` repositories read/write through a Convex client instead of `DbClient`.
2. `convex/_generated` is generated and committed.
3. `bun run build`, `bun test`, `bun run lint` green with the Convex data layer.

Until all four hold, only steps **A** (stand up backend) and **B** (push schema)
run — they create an empty, idle Convex instance and cost nothing to leave
running while the rewrite lands.

---

## Persistence guarantee

**Named volume `instatic_convex_data`** (declared in
`convex/compose.selfhosted.yml`, mounted at `/convex/data` in the `backend`
service) holds the **entire** Convex database and file storage. It is the only
durable asset.

Redeploys do **not** touch it because:

- The volume is declared with an explicit `name: instatic_convex_data`, so Docker
  does not project-prefix it and does not treat it as anonymous/disposable.
- A redeploy recreates **containers**, not named volumes. The new backend
  container re-mounts the same existing `/convex/data`.
- `INSTANCE_SECRET` + `INSTANCE_NAME` are preserved across redeploys by
  `deploy-convex.js` (it reads the current value and re-applies it), so admin
  keys and client tokens stay valid against the same data.

This is exactly the user requirement — *"get latest updates WITHOUT
deleting/replacing my Convex DB"*: push new code, redeploy the app and/or the
backend image, and `instatic_convex_data` is carried through untouched.

The only ways data is lost: `docker volume rm instatic_convex_data`, deleting the
Dokploy compose service *with* "remove volumes", or changing `INSTANCE_SECRET`
(invalidates keys, not data). Never do any of those without a verified backup —
see `docs/deployment/backup-restore.md`.
