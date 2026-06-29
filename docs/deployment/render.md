# Render Deployment

Instatic's data layer is a **self-hosted Convex backend**, not a managed Render Postgres or a SQLite disk. The CMS runs as two halves deployed together: the Bun app (repo-root `Dockerfile`) and a self-hosted Convex backend (`convex/compose.selfhosted.yml`) whose entire database lives in the persistent `instatic_convex_data` volume. There is no `DATABASE_URL` and no managed database to provision here.

The canonical deploy puts both halves on one host behind Dokploy + Traefik. See **[docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md)** for the full reference: standing up the Convex backend, pushing `convex/schema.ts`, then deploying the app with `CONVEX_SELF_HOSTED_URL` + an admin key as server runtime env (the browser never connects to Convex, so there is no Convex build arg).

## Related

- [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) — self-hosted Convex + app deploy reference
- [deployment/README.md](README.md) — deployment overview
- [backup-restore.md](backup-restore.md) — backing up the `instatic_convex_data` volume and uploads
