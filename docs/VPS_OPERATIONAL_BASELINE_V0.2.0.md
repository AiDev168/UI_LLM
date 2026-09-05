# Hinaa Portal VPS Operational Baseline — v0.2.0

**Status:** Operational baseline / verified production state  
**Portal:** `panel.hinaa.ir`  
**Server project path:** `/home/zoneroot/llm-stack/hinaa-portal`  
**Baseline:** `v0.2.0`

## Scope boundary

Active engineering scope:

- `hinaa-portal-frontend`
- `hinaa-portal-backend`
- `hinaa-portal-postgres`
- Portal source under `/home/zoneroot/llm-stack/hinaa-portal`

Protected operational dependencies:

- `qwen3-32b` / vLLM / H200
- `litellm` / `litellm-postgres`
- `open-webui`
- ClearML stack
- `cloudflared`
- existing production secrets

These are not Portal development tasks and must not be rebuilt, reconfigured, restarted, or upgraded as part of routine Portal work.

## Verified containers and exposure

```text
hinaa-portal-frontend   host 3100 -> container 3000
hinaa-portal-backend    container-only 8000
hinaa-portal-postgres   container-only 5432
```

Compose project: `hinaa-portal`  
Compose file: `/home/zoneroot/llm-stack/hinaa-portal/docker-compose.yml`

## Verified Docker networks

Portal network: `hinaa_portal`  
Backend external network: `litellm_default`  
Internal Portal-to-LiteLLM path: `http://litellm:4000`

Do not move this browser-side or replace it with the public hostname without an explicit architecture decision.

## Verified public routes

```text
app.hinaa.ir   -> ClearML
llm.hinaa.ir   -> LiteLLM
chat.hinaa.ir  -> Open WebUI
panel.hinaa.ir -> Hinaa Portal frontend
```

The Cloudflare Tunnel already exists. Do not create another one for Portal.

## Verified Portal database

```text
container: hinaa-portal-postgres
DB: hinaa
```

Current tables:

```text
public.users
public.portal_keys
public.conversations
public.messages
```

The live `messages` schema includes:

```text
prompt_tokens
completion_tokens
total_tokens
```

Portal PostgreSQL is deliberately separate from LiteLLM PostgreSQL and the ClearML data stores. Do not merge them.

Live data directory:

```text
/home/zoneroot/llm-stack/hinaa-portal/postgres-data
```

Do not delete, reinitialize, or replace it during a normal application deployment.

## Important port pitfall

```text
Host 127.0.0.1:8000 = vLLM / qwen3-32b
Container hinaa-portal-backend:8000 = Hinaa backend
```

Correct backend health check:

```bash
docker exec hinaa-portal-backend \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/openapi.json').status)"
```

## Secret boundary

The production `.env` is server-owned and must be preserved. Known secret variables include:

```text
POSTGRES_PASSWORD
JWT_SECRET
FERNET_KEY
LITELLM_MASTER_KEY
```

Never commit or paste their values. Never expose `LITELLM_MASTER_KEY` to the browser.

## v0.2.0 provenance

`v0.2.0` was deployed from a ZIP/artifact. The server directory is not a Git worktree, so branch, commit SHA, tag, and artifact checksum are not recorded. Do not invent provenance.

Known rollback source baseline:

```text
/home/zoneroot/llm-stack/hinaa-portal.backup-v0.1.3
```

## Current database backup

A logical custom-format dump was created from the live Portal PostgreSQL database:

```text
/home/zoneroot/llm-stack/hinaa-portal-backups/hinaa-20260905T121617Z.dump
```

Verified facts:

```text
custom format     = yes
db archive listing = PASS
non-empty          = PASS
isolated restore   = NOT TESTED
```

The archive contains the current Portal tables, table data, primary keys, indexes, and foreign keys.

## Current runtime reconciliation

The current VPS source and running image are the `v0.2.0` state, not the GitHub feature branch.

The live Backend already contains the canonical `Conversation` and `Message` models and routes in `backend/app/main.py`. Production schema is therefore the source of truth for persistence.

The feature branch was corrected so it does not introduce the conflicting `conversation_messages` model. The temporary compatibility entrypoint was removed and the Backend Dockerfile now uses the same canonical command as production:

```text
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The feature-branch frontend is an application refinement layer over the existing backend contract; it must not introduce a parallel database model.

## Verified healthy baseline

```text
Portal containers          = UP
Portal PostgreSQL          = healthy
http://127.0.0.1:3100      = HTTP 200
https://panel.hinaa.ir      = HTTP 200
Backend /openapi.json       = HTTP 200 from inside backend container
```

## Deployment safety rules

Normal Portal deployment must:

1. target only the `hinaa-portal` Compose project
2. preserve `.env`
3. preserve `postgres-data`
4. take a logical `pg_dump` before DB-changing releases
5. build only Portal
6. start only Portal
7. run Portal health and smoke checks

Forbidden routine operations:

```text
- docker compose down -v
- docker system prune
- docker volume prune
- docker network prune
- deleting/reinitializing postgres-data
- changing Cloudflare routing
- creating a second Tunnel
- changing public ports without an architecture decision
- modifying vLLM/Qwen/H200
- modifying LiteLLM
- modifying ClearML
- modifying Open WebUI
- overwriting .env
```

## Truth hierarchy

```text
Running server behavior > deployment assumptions
Running DB schema    > feature-branch schema assumptions
Repository code      > documentation assumptions
```

A feature is not considered complete until the repository implementation, API contract, database schema, and relevant running behavior are consistent.
