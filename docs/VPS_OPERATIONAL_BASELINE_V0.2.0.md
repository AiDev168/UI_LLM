# Hinaa Portal VPS Operational Baseline — v0.2.0

**Status:** Operational baseline / do not reinterpret as a fresh infrastructure audit  
**Portal:** `panel.hinaa.ir`  
**Server project path:** `/home/zoneroot/llm-stack/hinaa-portal`  
**Baseline version:** `v0.2.0`

This document records facts established from the current VPS state and deployment history. It is intentionally conservative: **running-server truth and repository truth must be verified separately**.

## 1. Scope boundary

The active engineering scope is the Hinaa customer Portal:

- `hinaa-portal-frontend`
- `hinaa-portal-backend`
- `hinaa-portal-postgres`
- application source under `/home/zoneroot/llm-stack/hinaa-portal`

The following are existing operational dependencies and are **not Portal development tasks**:

- `qwen3-32b` / vLLM / H200 model serving
- `litellm` and `litellm-postgres`
- `open-webui`
- ClearML stack (`clearml-webserver`, `clearml-apiserver`, `clearml-fileserver`, `async_delete`, `clearml-mongo`, `clearml-redis`, `clearml-elastic`)
- `cloudflared`
- existing production secrets

Do not troubleshoot, upgrade, rebuild, or reconfigure these systems as part of normal Portal feature work unless a specific regression is directly caused by a Portal change.

## 2. Current Portal containers

| Service | Container | Image | Exposure |
|---|---|---|---|
| frontend | `hinaa-portal-frontend` | `hinaa-portal-frontend` | host `3100 -> 3000` |
| backend | `hinaa-portal-backend` | `hinaa-portal-backend` | container-only `8000` |
| postgres | `hinaa-portal-postgres` | `postgres:17-alpine` | container-only `5432` |

Compose project:

```text
hinaa-portal
```

Compose file:

```text
/home/zoneroot/llm-stack/hinaa-portal/docker-compose.yml
```

## 3. Network topology

Portal network:

```text
hinaa_portal
```

Backend is additionally attached to the existing external network:

```text
litellm_default
```

The Portal backend therefore reaches LiteLLM through Docker networking:

```text
http://litellm:4000
```

Do not replace this with a browser-side direct call or unnecessarily route internal traffic through the public hostname.

## 4. Public routing

Existing Cloudflare routing is:

```text
app.hinaa.ir   -> ClearML
llm.hinaa.ir   -> LiteLLM
chat.hinaa.ir  -> Open WebUI
panel.hinaa.ir -> Hinaa Portal frontend
```

The Cloudflare Tunnel already exists. **Do not create another tunnel for the Portal.**

## 5. LLM request path

The intended customer request path is:

```text
Browser
  -> Hinaa Portal frontend
  -> Hinaa Portal backend
  -> LiteLLM
  -> vLLM
  -> Qwen3-32B
  -> H200
```

The browser must not receive the LiteLLM master key and must not call vLLM directly.

## 6. Database separation

Portal data is stored in its own PostgreSQL instance:

```text
container: hinaa-portal-postgres
DB: hinaa
```

Current application tables verified on the running server:

```text
public.users
public.portal_keys
public.conversations
public.messages
```

Portal PostgreSQL is intentionally separate from:

```text
LiteLLM PostgreSQL
ClearML MongoDB
ClearML Redis
ClearML Elasticsearch
```

**Never merge these databases as part of Portal work.**

The live PostgreSQL data directory is bind-mounted from:

```text
/home/zoneroot/llm-stack/hinaa-portal/postgres-data
```

to:

```text
/var/lib/postgresql/data
```

Treat `postgres-data` as production data. Do not delete, reinitialize, or replace it during a normal application deployment.

## 7. Important port pitfall

On the VPS host:

```text
127.0.0.1:8000 -> vLLM / qwen3-32b
```

Inside the Portal backend container:

```text
hinaa-portal-backend:8000 -> Hinaa backend
```

Therefore a host-side `curl http://127.0.0.1:8000/...` is **not** a backend health check.

Correct backend checks include:

```bash
docker exec hinaa-portal-backend python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/openapi.json').status)"
```

## 8. Secrets boundary

The live Portal directory contains a restricted `.env` file. The production deployment must preserve the existing `.env` and must not replace it with a ZIP or repository copy.

Known secret variables include:

```text
POSTGRES_PASSWORD
JWT_SECRET
FERNET_KEY
LITELLM_MASTER_KEY
```

Never commit these values. Never paste them into chat. Never expose `LITELLM_MASTER_KEY` to the frontend/browser.

## 9. Deployment provenance: v0.2.0

The current `v0.2.0` deployment is artifact/ZIP based.

Known facts:

- the live server directory is not a Git worktree
- branch/commit/tag for v0.2.0 are not recorded
- ZIP checksum/hash is not recorded
- the original artifact was `hinaa-portal-v0.2.0.zip`

Do **not invent** a Git SHA, branch, or tag for v0.2.0.

Future releases should record at minimum:

```text
repository
branch
commit SHA
artifact/image identifier
build timestamp
migration version
backup timestamp/path
rollback procedure
```

## 10. Known rollback baseline

Before v0.2.0 deployment, a filesystem backup was created at:

```text
/home/zoneroot/llm-stack/hinaa-portal.backup-v0.1.3
```

It included application files and the Portal PostgreSQL data directory.

This is a **filesystem backup**, not a verified `pg_dump` backup.

Current backup knowledge:

```text
filesystem backup exists       = yes
logical pg_dump confirmed       = no
restore test confirmed         = no
```

A restore procedure must therefore not be described as tested until it is actually exercised against an isolated PostgreSQL instance.

## 11. v0.2.0 deployment procedure already used

The documented successful v0.2.0 procedure was:

1. Create filesystem backup:

```bash
cd ~/llm-stack
sudo cp -a hinaa-portal hinaa-portal.backup-v0.1.3
```

2. Extract the v0.2.0 ZIP/artifact separately.
3. Overlay application files onto the existing Portal directory while preserving the live `.env` and `postgres-data`.
4. Build:

```bash
cd ~/llm-stack/hinaa-portal
docker compose build --pull
```

5. Start/update:

```bash
docker compose up -d
```

No manual Alembic migration was recorded for v0.2.0.

## 12. Required pre-deployment safety procedure for future DB changes

Before any change that could alter PostgreSQL schema or data:

1. Verify the target Compose project and containers.
2. Create a logical `pg_dump` backup.
3. Record the backup path and timestamp.
4. Verify the dump file is non-empty and readable.
5. Apply the smallest required schema/application change.
6. Run health checks and application smoke tests.

Example read-only identity check:

```bash
cd /home/zoneroot/llm-stack/hinaa-portal
docker compose ps
```

Example logical backup (the command writes a new backup file and does not modify the live database):

```bash
mkdir -p ~/llm-stack/hinaa-portal-backups

docker exec hinaa-portal-postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > ~/llm-stack/hinaa-portal-backups/hinaa-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Verify the dump exists:

```bash
ls -lh ~/llm-stack/hinaa-portal-backups/
```

Do not delete the filesystem rollback baseline when creating logical backups.

## 13. Safe Portal deployment checklist

For a normal Portal-only application deployment:

```text
[ ] Confirm repository change is reviewed
[ ] Confirm expected branch/commit locally
[ ] Confirm live .env will be preserved
[ ] Confirm postgres-data will be preserved
[ ] If DB change: take verified pg_dump
[ ] Do not stop unrelated stacks
[ ] Build only the Portal compose project
[ ] Start only the Portal compose project
[ ] Check frontend/backend/postgres status
[ ] Check panel.hinaa.ir
[ ] Check backend /openapi.json from inside the backend container
[ ] Smoke-test authentication
[ ] Smoke-test API-key flow
[ ] Smoke-test Chat/streaming
[ ] Check logs for startup/runtime errors
```

## 14. Forbidden routine operations

Do not use these as routine Portal deployment commands:

```bash
docker compose down -v
docker system prune
docker volume prune
docker network prune
```

Do not:

- delete `postgres-data`
- recreate the Portal database unnecessarily
- change public ports without an explicit architecture decision
- change Cloudflare routes
- create a second Cloudflare Tunnel
- modify vLLM configuration
- modify LiteLLM infrastructure
- modify ClearML
- modify Open WebUI
- modify Qwen model files
- overwrite `.env`
- expose production secrets

## 15. Truth hierarchy

When deciding whether a feature is complete:

```text
Running server behavior > deployment assumptions
Repository code      > documentation assumptions
Database schema      > UI assumptions
```

A feature described in documentation is not considered complete until the repository implementation and the running API/schema support it.
