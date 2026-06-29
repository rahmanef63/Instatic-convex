# VPS Deployment

This guide covers running Instatic on a single VPS with Docker.

Instatic runs as two halves: the **Bun app** (the CMS, built from the repo-root `Dockerfile`) and a **self-hosted Convex backend** (the data layer). The app connects to Convex over `CONVEX_SELF_HOSTED_URL`; the entire database lives in the Convex backend's persistent `instatic_convex_data` volume. The app keeps its own `uploads` volume for media, fonts, plugin packages, and published artefacts.

For the Convex backend itself — the compose template (`convex/compose.selfhosted.yml`), the `api-`/`site-`/`dash-` subdomains, the admin key, and the persistence guarantee — follow **[docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md)**. This page covers the app half and how it connects.

---

## Prerequisites

Install Docker Engine and Docker Compose on the VPS. If using TLS, point a domain's DNS A/AAAA records at the server and open ports `80` and `443`.

Stand up (or point at) the Convex backend first — see [DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) steps A and B. Record its URL and admin key; the app needs them.

## App environment

The app reads these at runtime (server side):

| Var | Value | Notes |
|---|---|---|
| `CONVEX_SELF_HOSTED_URL` | `https://api-<your-domain>` | server → Convex connection |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | `<admin key>` | trusted-backend access; keep it secret, never bake it into the image |
| `UPLOADS_DIR` | `/app/uploads` | persistent media / fonts / plugins / published artefacts |
| `STATIC_DIR` | `/app/dist` | built admin SPA (Docker default) |
| `INSTATIC_SECRET_KEY` | output of `bun run scripts/generate-secret-key.ts` | encrypts AI credentials, plugin secrets, TOTP seeds |
| `PORT` | `3001` | Dockerfile default |
| `PUBLIC_ORIGIN` | `https://<your-domain>` | CSRF origin when a proxy terminates TLS |
| `TRUSTED_PROXY_CIDRS` | e.g. `172.16.0.0/12` | client-IP attribution only (audit logs, rate limits), not CSRF |

The browser never connects to Convex; it calls the Bun server's REST API. Only the server needs `CONVEX_SELF_HOSTED_URL` (+ `CONVEX_SELF_HOSTED_ADMIN_KEY`), as runtime env — there is no Convex build arg. Set `INSTATIC_SECRET_KEY` before adding AI provider credentials, saving plugin secret settings, or enabling TOTP MFA in production.

## Run the app

Using the published image:

```sh
docker volume create uploads

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e CONVEX_SELF_HOSTED_URL="https://api-<your-domain>" \
  -e CONVEX_SELF_HOSTED_ADMIN_KEY="<admin key>" \
  -e UPLOADS_DIR=/app/uploads \
  -e STATIC_DIR=/app/dist \
  -e INSTATIC_SECRET_KEY="<generate-secret-key output>" \
  -v uploads:/app/uploads \
  --restart unless-stopped \
  ghcr.io/corebunch/instatic:<version>
```

Build from source with `docker build -t instatic:local .` — no Convex build arg is needed. The Convex URL and admin key are supplied at `docker run` time (the `-e CONVEX_SELF_HOSTED_URL` / `-e CONVEX_SELF_HOSTED_ADMIN_KEY` flags above), because only the server connects to Convex.

Open `http://server-ip:3001/admin`. The first visit creates the site and admin account.

Persistent data:

| Volume | Mount path | Contents |
|---|---|---|
| `uploads` | `/app/uploads` | media, fonts, plugins, published artefacts |
| `instatic_convex_data` | `/convex/data` (Convex backend) | the entire Convex database + file storage |

## HTTPS

Put an HTTPS-capable reverse proxy in front (Caddy is bundled — see [tls-caddy.md](tls-caddy.md)) and set `PUBLIC_ORIGIN=https://your-domain` so the CSRF origin check matches the public URL even though the proxy hands the app plain HTTP.

## Operations

```sh
# health
curl http://localhost:3001/health

# logs
docker logs -f instatic

# update the app — the instatic_convex_data volume is never touched
docker pull ghcr.io/corebunch/instatic:<version>
docker rm -f instatic && docker run -d ...   # re-run with the same env + volumes
```

## Without Docker (direct Bun install)

From a source checkout:

```sh
bun install
bun run build
CONVEX_SELF_HOSTED_URL=https://api-<your-domain> \
  CONVEX_SELF_HOSTED_ADMIN_KEY=<admin key> \
  STATIC_DIR=./dist \
  UPLOADS_DIR=./uploads \
  INSTATIC_SECRET_KEY=<generate-secret-key output> \
  TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128 \
  PORT=3001 \
  bun run server/index.ts
```

`bun run build` needs no Convex env — the browser never connects to Convex, so nothing about Convex is inlined into the admin bundle. The Convex URL + admin key are server runtime env, set on the `bun run server/index.ts` command above. `STATIC_DIR` must point at the built SPA (`dist/` after `bun run build`). Wrap the server command in a process supervisor (systemd, pm2, supervisord) for auto-restart, and front it with a TLS proxy, setting `PUBLIC_ORIGIN=https://your-domain` so the CSRF origin check matches the public URL.

## Data safety

The durable assets are the Convex `instatic_convex_data` volume (the database) and the app `uploads` volume (media). `docker rm` of a container keeps named volumes; removing a volume — or a compose service "with volumes" — destroys data. Back both up: [backup-restore.md](backup-restore.md).

## Related

- [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) — self-hosted Convex backend (the data layer)
- [deployment/README.md](README.md) — deployment overview
- [docker-image.md](docker-image.md) — generic Docker image contract
- [tls-caddy.md](tls-caddy.md) — HTTPS overlay
- [backup-restore.md](backup-restore.md) — backup and restore procedures
