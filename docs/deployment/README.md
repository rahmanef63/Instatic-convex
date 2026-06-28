# Deployment

This index maps the supported deployment shape to the files, variables, and persistence rules it needs.

Instatic runs as two halves: the **Bun app** (packaged by the repo-root `Dockerfile`) and a **self-hosted Convex backend** (the data layer). The app reads runtime configuration from `server/config.ts`: `PORT`, `UPLOADS_DIR`, `STATIC_DIR`, `PUBLIC_ORIGIN`, `TRUSTED_PROXY_CIDRS`, and the Convex connection (`CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY`). Reversible server secrets — AI provider credentials, plugin secret settings, MFA TOTP seeds — are encrypted with `INSTATIC_SECRET_KEY`. There is no migration step at boot; Convex applies `convex/schema.ts` on deploy.

---

## TL;DR

The canonical deploy puts both halves on one host behind Dokploy + Traefik: stand up the Convex backend, push the schema, then deploy the app. Full reference: **[docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md)**.

| Target | Use when | Data layer | Persistent storage | Docs |
|---|---|---|---|---|
| Dokploy (canonical) | Self-hosted, both halves on one host | self-hosted Convex backend | `instatic_convex_data` (database) + app `uploads` volume | [DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) |
| VPS Docker | Self-hosted server, full control | self-hosted Convex backend | `instatic_convex_data` + `uploads` named volumes | [vps.md](vps.md) |
| Generic Docker host | Any platform that runs the Dockerfile/image | self-hosted Convex backend | volume for `instatic_convex_data` + a mount for `uploads` | [docker-image.md](docker-image.md) |
| VPS HTTPS | Public domain on a VPS | unchanged | Caddy cert volume plus app/Convex volumes | [tls-caddy.md](tls-caddy.md) |

Back up both the Convex data volume and the uploads volume. See [backup-restore.md](backup-restore.md).

## Runtime Contract

The app process configures the same way everywhere:

```txt
PORT                          HTTP port the Bun server listens on
CONVEX_SELF_HOSTED_URL        https://api-<your-domain> — server → Convex connection (or CONVEX_URL)
CONVEX_SELF_HOSTED_ADMIN_KEY  trusted-backend admin key for the Convex backend
UPLOADS_DIR                   directory for media, plugin packs, fonts, and published disk artefacts
STATIC_DIR                    built admin SPA directory; /app/dist in the Docker image
INSTATIC_SECRET_KEY           base64 32-byte key for encrypted server secrets
PUBLIC_ORIGIN                 comma-separated public origin(s) the CSRF check trusts
TRUSTED_PROXY_CIDRS           optional; trusts proxy peers for forwarded client-IP attribution only — NOT CSRF
```

The **browser** admin bundle additionally needs `VITE_CONVEX_URL` (the public Convex URL) at `bun run build` time — Vite inlines it, so it must be a Docker build arg, not just a runtime env.

Generate `INSTATIC_SECRET_KEY` with `bun run scripts/generate-secret-key.ts` before adding Anthropic, OpenAI, or OpenRouter credentials or enabling TOTP MFA in production. Without it, the admin loads but saving reversible secrets fails because there is no stable encryption key.

The Docker image sets:

```txt
PORT=3001
STATIC_DIR=/app/dist
UPLOADS_DIR=/app/uploads
```

When a proxy terminates HTTPS before forwarding HTTP to the container, the CSRF origin check derives the site's public origin from `PUBLIC_ORIGIN`. Set it explicitly when adding a custom domain. `TRUSTED_PROXY_CIDRS` is independent of CSRF and only attributes the real client IP for audit logs and rate-limit keys.

## Image Availability

The published GHCR image is the default portable install path for the app:

```sh
docker pull ghcr.io/corebunch/instatic:latest
docker pull ghcr.io/corebunch/instatic:0.0.6   # pin a semver tag for predictable upgrades
```

The maintainer release target is `ghcr.io/corebunch/instatic`, documented in [release-workflow.md](release-workflow.md).

## Data layer (self-hosted Convex)

The data layer is a self-hosted Convex backend, not a database the app provisions itself. There is no `DATABASE_URL`. The app connects over `CONVEX_SELF_HOSTED_URL` + an admin key; the whole database (content rows, users, sessions, media records, audit events) plus Convex file storage lives in the `instatic_convex_data` named volume on the backend. Standing up the backend, pushing `convex/schema.ts`, and the persistence guarantee are all in [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md).

## Persistence Rules

Two durable assets:

- **`instatic_convex_data`** — the Convex backend volume. The single durable copy of the database + Convex file storage. A redeploy never removes it; only `docker volume rm` (or a compose service deleted "with volumes") destroys it.
- **`UPLOADS_DIR`** — required for durable media regardless of the data layer. It stores uploaded media originals and variants, uploaded fonts, plugin packages and module packs, and published static artefacts under `published/current`.

## Docs Inventory

| File | Role |
|---|---|
| [DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) | Canonical self-hosted Convex + app deploy (Dokploy) |
| [vps.md](vps.md) | Docker install on a VPS: the app + the self-hosted Convex backend |
| [docker-image.md](docker-image.md) | Generic Docker image contract and `docker run` examples |
| [tls-caddy.md](tls-caddy.md) | Caddy TLS overlay for VPS installs |
| [backup-restore.md](backup-restore.md) | Backing up the Convex data volume and uploads |
| [release-workflow.md](release-workflow.md) | Maintainer image publishing workflow |
| [railway.md](railway.md) / [render.md](render.md) | Note: managed-Postgres targets, superseded by the self-hosted Convex data layer |

## Related

- `server/config.ts` — runtime env parsing
- `server/convex/client.ts` — Convex connection (reads `CONVEX_SELF_HOSTED_URL` + admin key)
- `server/index.ts` — server boot (asserts the Convex backend, media storage, plugins)
- `Dockerfile` — production image contract
- `convex/compose.selfhosted.yml` — self-hosted Convex backend compose reference
