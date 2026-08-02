# HTTPS via Caddy (compose.tls.yml)

The `compose.tls.yml` override runs a Caddy reverse proxy in front of the CMS app, terminating TLS at a real domain with auto-provisioned Let's Encrypt certificates. It composes on top of the production app stack — add `-f compose.tls.yml` to the app's Compose command. (The data layer is a separate self-hosted Convex backend — see [DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md).)

---

## TL;DR

Set `DOMAIN`, keep `Caddyfile` beside `compose.tls.yml`, then layer the TLS override onto the app's Compose command:

```sh
docker compose -f compose.prod.yml -f compose.tls.yml -f compose.build.yml up -d --build
```

When using an accessible published image, omit `compose.build.yml` and `--build`.

## Prerequisites

1. **A domain you control** with DNS A/AAAA records pointing at the server's public IP.
2. **Ports 80 and 443** open to the public internet (Let's Encrypt HTTP-01 and TLS-ALPN-01 challenges).
3. The `Caddyfile` and `compose.tls.yml` files in your install directory (already in the repo at the root).

## One-time setup

Edit `.env` and set:

```sh
DOMAIN=cms.example.com
LETSENCRYPT_EMAIL=ops@example.com   # optional but recommended (cert expiry notices)
```

The app connects to the self-hosted Convex backend over `CONVEX_SELF_HOSTED_URL` + an admin key (see [vps.md](vps.md) and [DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md)); the app stack itself has no database password.

## Bring it up

```sh
docker compose -f compose.prod.yml -f compose.tls.yml -f compose.build.yml up -d --build
```

The first request to `https://cms.example.com` triggers cert issuance (takes a few seconds). Cert state persists in the `caddy_data` named volume across restarts and re-deploys.

## What the override does

- Adds a `caddy` service listening on `:80`, `:443`, and `:443/udp` (HTTP/3).
- Auto-provisions a Let's Encrypt certificate for `${DOMAIN}` on first request.
- Reverse-proxies all traffic to `app:3001` over the internal Docker network.
- **Removes the `app` host port mapping** (`!reset []`) so the only public-facing port is Caddy. The CMS is no longer reachable on `:3001` from outside; only Caddy can reach it via the docker network.
- Sets `PUBLIC_ORIGIN` to `https://${DOMAIN}` so the CSRF origin check matches the public URL even though Caddy hands the container plain HTTP. Override `PUBLIC_ORIGIN` directly (a comma-separated list) to serve more than one domain.
- Sets `TRUSTED_PROXY_CIDRS` to the Docker bridge range by default so login rate limits and audit logs use the real client IP from Caddy's `X-Forwarded-For`. This is client-IP attribution only and has no bearing on CSRF. If you run Caddy on a custom Docker network, override `TRUSTED_PROXY_CIDRS` with that network's CIDR.

## Verifying

```sh
# HTTPS should serve the admin shell:
curl -I https://cms.example.com/health
# → HTTP/2 200

# Plain HTTP should redirect to HTTPS automatically (Caddy default):
curl -I http://cms.example.com/
# → HTTP/1.1 308 Permanent Redirect
# → location: https://cms.example.com/
```

If cert provisioning fails, check Caddy's logs:

```sh
docker compose -f compose.prod.yml -f compose.tls.yml logs caddy
```

Common issues:
- **DNS not propagated** — `dig +short cms.example.com` from outside the server should return your IP.
- **Port 80 blocked** — Let's Encrypt HTTP-01 needs port 80 reachable. UFW/iptables/cloud firewall rules.
- **Rate limit** — Let's Encrypt limits cert issuance per domain per week. While testing, point Caddy at the staging directory by adding `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` inside the global `{ ... }` block of `Caddyfile`.

## Customizing the Caddyfile

The Caddyfile at the repo root is a template. Common customizations:

**Multiple domains:**

```caddy
cms.example.com, www.cms.example.com {
    encode zstd gzip
    reverse_proxy app:3001
}
```

**Basic auth on /admin:**

```caddy
{$DOMAIN} {
    encode zstd gzip
    @admin path /admin /admin/*
    basic_auth @admin {
        # Generate with: caddy hash-password
        admin $2a$14$...
    }
    reverse_proxy app:3001
}
```

**IP allowlist on /admin:**

```caddy
{$DOMAIN} {
    encode zstd gzip
    @admin path /admin /admin/*
    @trusted remote_ip 203.0.113.0/24
    handle @admin {
        @block not @trusted
        respond @block 403
        reverse_proxy app:3001
    }
    reverse_proxy app:3001
}
```

**Static caching for published pages:**

The CMS already sets `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` (hashed). For additional CDN-friendly caching at the Caddy layer:

```caddy
@static path *.css *.js *.png *.webp *.woff2
header @static Cache-Control "public, max-age=31536000, immutable"
```

After editing, reload Caddy without restarting:

```sh
docker compose -f compose.prod.yml -f compose.tls.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## Removing TLS

To go back to plain HTTP on `:3001`, remove only the TLS override:

```sh
docker compose -f compose.prod.yml -f compose.tls.yml down
docker compose -f compose.prod.yml -f compose.build.yml up -d --build
```

The certs in `caddy_data` are preserved; if you re-enable TLS later, Caddy reuses the existing cert if it's still valid.

## Related

- [deployment/README.md](README.md) — deployment overview
- [vps.md](vps.md) — VPS Compose install commands
- [backup-restore.md](backup-restore.md) — backing up app and Caddy volumes
- `compose.tls.yml` — Caddy service and port override
- `Caddyfile` — reverse proxy and security headers
