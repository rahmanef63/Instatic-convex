# Backup And Restore

A complete backup is two things: the **Convex data volume** and the **uploaded media**. Both are Docker named volumes; archive each.

---

## What to back up

| Asset | Where it lives | Holds |
|---|---|---|
| `instatic_convex_data` | Convex backend volume, mounted at `/convex/data` | the **entire** Convex database + Convex file storage — every content row, user, session, media record, audit event |
| `uploads` | app volume, mounted at `UPLOADS_DIR` | uploaded media originals + variants, fonts, plugin packages, published static artefacts under `published/current` |

The Convex volume is the only durable copy of the database — there is no separate SQL dump. See [DEPLOY-CONVEX.md → Persistence guarantee](../DEPLOY-CONVEX.md).

## Back up

Archive each named volume to a tarball on the host. Find the exact names with `docker volume ls` (Compose may project-prefix them).

```sh
mkdir -p backups

# Convex database + file storage
docker run --rm \
  -v instatic_convex_data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar czf "/backup/instatic-convex-$(date +%F).tgz" -C /data .

# Uploaded media
docker run --rm \
  -v uploads:/uploads:ro \
  -v "$PWD/backups:/backup" \
  alpine \
  tar czf "/backup/instatic-uploads-$(date +%F).tgz" -C /uploads .
```

> Snapshot both volumes from the same point in time so the media records stored in Convex stay consistent with the files on the uploads volume.

## Restore

Stop the affected service before restoring — a restore overwrites live data.

```sh
# Convex data (stop the backend service first)
docker run --rm \
  -v instatic_convex_data:/data \
  -v "$PWD/backups:/backup" \
  alpine \
  sh -lc "rm -rf /data/* && tar xzf /backup/instatic-convex-YYYY-MM-DD.tgz -C /data"

# Uploads
docker run --rm \
  -v uploads:/uploads \
  -v "$PWD/backups:/backup" \
  alpine \
  sh -lc "rm -rf /uploads/* && tar xzf /backup/instatic-uploads-YYYY-MM-DD.tgz -C /uploads"
```

Then bring the stack back up. The Convex backend re-mounts the restored `/convex/data` and serves the restored database. `INSTANCE_SECRET` must be unchanged for existing admin keys and client tokens to stay valid against it.

## Never do without a verified backup

- `docker volume rm instatic_convex_data` — deletes the entire database.
- Deleting the Dokploy compose service **with** "remove volumes".
- Changing `INSTANCE_SECRET` — invalidates admin keys and client tokens (the data survives, but keys against it do not).

## Related

- [docs/DEPLOY-CONVEX.md](../DEPLOY-CONVEX.md) — self-hosted Convex deploy + persistence guarantee
- [deployment/README.md](README.md) — deployment overview
- [vps.md](vps.md) — VPS install + volume names
