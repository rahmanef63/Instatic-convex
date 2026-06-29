# Generic Docker Image

This guide covers the production Docker image for the Instatic app outside the bundled VPS Compose files.

The image contains the built admin UI, Bun server, public renderer, and CMS API routes. It does not run Vite or install packages at container startup. The app is a Convex client: it connects to a self-hosted Convex backend (the data layer) — there is no database inside the image.

---

## TL;DR

Run the image with:

- `PORT` set to the platform's HTTP port (defaults to `3001`)
- `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` pointing at the self-hosted Convex backend
- `UPLOADS_DIR` mounted on persistent storage
- `STATIC_DIR=/app/dist`
- `INSTATIC_SECRET_KEY` set before configuring AI provider credentials, plugin secret settings, or TOTP MFA
- `PUBLIC_ORIGIN` set to the site's public origin when a proxy terminates HTTPS in front of the container

The browser never connects to Convex; it calls the Bun server's REST API. Only the server needs `CONVEX_SELF_HOSTED_URL` (+ admin key), as runtime env — the image builds with no Convex build arg. Stand up the Convex backend first — see [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md).

## Build Locally

```sh
docker build -t instatic:local .
# No Convex build arg is needed. Point the app at your backend at run time with
# -e CONVEX_SELF_HOSTED_URL / -e CONVEX_SELF_HOSTED_ADMIN_KEY (see Run, below).
```

## Published Image

GHCR is the canonical image registry:

```sh
docker pull ghcr.io/corebunch/instatic:latest
docker pull ghcr.io/corebunch/instatic:0.0.6
```

The published image is built for `linux/amd64`. Use it on x86_64 hosts; ARM64 hosts should build from source for now.

## Run

```sh
docker volume create instatic-uploads

docker run -d \
  --name instatic \
  -p 3001:3001 \
  -e PORT=3001 \
  -e CONVEX_SELF_HOSTED_URL="https://api-<your-domain>" \
  -e CONVEX_SELF_HOSTED_ADMIN_KEY="<admin key>" \
  -e STATIC_DIR=/app/dist \
  -e UPLOADS_DIR=/app/uploads \
  -e INSTATIC_SECRET_KEY="replace-with-output-of-generate-secret-key" \
  -v instatic-uploads:/app/uploads \
  --restart unless-stopped \
  instatic:local
```

The volume holds uploaded media, fonts, plugin packs, and published disk artefacts. The database is not in the image or this volume — it lives in the Convex backend's `instatic_convex_data` volume. Replace `instatic:local` with `ghcr.io/corebunch/instatic:<tag>` when deploying from a published image.

## Required Runtime Variables

| Variable | Required | Value |
|---|---|---|
| `CONVEX_SELF_HOSTED_URL` | Yes | `https://api-<your-domain>` (or `CONVEX_URL`) — server → Convex backend |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | Yes | trusted-backend admin key for the Convex backend |
| `UPLOADS_DIR` | Yes for durable media | Persistent upload directory |
| `STATIC_DIR` | Yes in Docker | `/app/dist` |
| `PORT` | Platform-dependent | HTTP listen port; defaults to `3001` |
| `INSTATIC_SECRET_KEY` | Yes for reversible server secrets | Output of `bun run scripts/generate-secret-key.ts` |
| `PUBLIC_ORIGIN` | Behind a TLS-terminating proxy | Comma-separated public origins for the CSRF check, e.g. `https://www.example.com` |
| `TRUSTED_PROXY_CIDRS` | Optional | Comma-separated trusted proxy CIDRs for client-IP attribution only — **not** used for CSRF. Trust only your real proxy CIDRs; never `0.0.0.0/0` for a public service |

No Convex build arg: the browser never connects to Convex (it calls the Bun server's REST API), so nothing about Convex is inlined into the admin JS at `bun run build`. The Convex URL + admin key are server runtime env only — supplied at `docker run` / compose `environment:` time.

`INSTATIC_SECRET_KEY` is the stable AES master key for reversible server secrets, including Anthropic, OpenAI, and OpenRouter credentials and TOTP MFA seeds. If it is missing in production, adding a credential or enabling TOTP MFA fails. If it is rotated or lost, existing stored credentials must be re-entered and TOTP MFA re-enrolled.

## Health Check

```sh
curl http://localhost:3001/health
```

Expected response:

```json
{"status":"ok","ts":1234567890}
```

## Related

- [deployment/README.md](README.md) — deployment overview
- [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) — self-hosted Convex backend (the data layer)
- [vps.md](vps.md) — Docker install on a VPS
- [backup-restore.md](backup-restore.md) — backing up the Convex data volume and uploads
- `Dockerfile` — production image definition
- `server/config.ts` — runtime env parsing
