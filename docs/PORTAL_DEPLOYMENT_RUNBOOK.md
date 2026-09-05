# Hinaa Portal Deployment Runbook

This runbook is for `panel.hinaa.ir` only. It is designed to prevent accidental impact to the existing LLM/ClearML/Open WebUI infrastructure.

## Current target

```text
/home/zoneroot/llm-stack/hinaa-portal
Compose project: hinaa-portal
```

Protected dependencies:

```text
qwen3-32b / vLLM / H200
litellm / litellm-postgres
open-webui
clearml-*
cloudflared
```

Protected data/secrets:

```text
/home/zoneroot/llm-stack/hinaa-portal/.env
/home/zoneroot/llm-stack/hinaa-portal/postgres-data
```

Never overwrite or recreate these as part of a normal Portal application deployment.

## Phase 0 — Read-only preflight

```bash
cd /home/zoneroot/llm-stack/hinaa-portal

echo "=== compose status ==="
docker compose ps

echo "=== portal containers ==="
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | grep -E '^(NAMES|hinaa-portal-)'
echo "=== disk ==="
df -h /
echo "=== protected data ==="
sudo ls -ld /home/zoneroot/llm-stack/hinaa-portal/postgres-data
sudo ls -l /home/zoneroot/llm-stack/hinaa-portal/.env
```

Stop if the Portal state is not the expected one.

## Phase 1 — Logical backup before DB changes

A logical PostgreSQL backup is required for any release that changes schema or data.

```bash
mkdir -p ~/llm-stack/hinaa-portal-backups

docker exec hinaa-portal-postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > ~/llm-stack/hinaa-portal-backups/hinaa-$(date -u +%Y%m%dT%H%M%SZ).dump

latest=$(ls -1t ~/llm-stack/hinaa-portal-backups/*.dump | head -1)
chmod 600 "$latest"
ls -lh "$latest"
test -s "$latest" && echo "BACKUP_FILE_OK"
```

A custom-format archive can be inspected without modifying the live database:

```bash
docker cp "$latest" hinaa-portal-postgres:/tmp/portal-backup.inspect.dump

docker exec hinaa-portal-postgres \
  pg_restore -l /tmp/portal-backup.inspect.dump | head -60

docker exec hinaa-portal-postgres \
  rm -f /tmp/portal-backup.inspect.dump
```

An isolated restore test is separate work and must not be performed against the live Portal database.

## Phase 2 — Fetch/review the intended release

The current VPS directory is not a Git worktree. Never assume it is the same code as the GitHub branch.

Before deployment, obtain the exact reviewed GitHub branch/commit/artifact and compare it with the current server source. Do not overlay production from an unreviewed working tree.

## Phase 3 — Preserve the live environment

Never copy repository `.env` over the server `.env`.

Never delete or replace `postgres-data`.

When an artifact deployment is required, extract the artifact into a temporary directory first. Overlay only the application source/config intended by the reviewed release.

For an emergency application-source checkpoint, when disk space permits:

```bash
cd ~/llm-stack
sudo cp -a hinaa-portal "hinaa-portal.predeploy-$(date -u +%Y%m%dT%H%M%SZ)"
```

This does not replace the established `v0.1.3` rollback baseline.

## Phase 4 — Build Portal only

```bash
cd ~/llm-stack/hinaa-portal
docker compose build --pull
```

This command targets the `hinaa-portal` Compose project only.

Never use a global Docker prune as part of Portal deployment.

## Phase 5 — Start/update Portal only

```bash
cd ~/llm-stack/hinaa-portal
docker compose up -d
```

Do not run `docker compose down` unless there is a specific, reviewed reason and the rollback consequences are understood.

## Phase 6 — Immediate health checks

```bash
cd ~/llm-stack/hinaa-portal
docker compose ps

curl -fsSI http://127.0.0.1:3100 | head -1
curl -fsSI https://panel.hinaa.ir | head -1

docker exec hinaa-portal-backend \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/openapi.json').status)"
```

Remember: host `127.0.0.1:8000` is vLLM, not the Portal backend.

Expected:

```text
frontend           UP
backend            UP
postgres           UP / healthy
frontend local     HTTP 200
panel.hinaa.ir     HTTP 200
backend openapi    HTTP 200
```

## Phase 7 — Portal smoke tests

Perform these through the real Portal UI/API without printing secrets:

```text
[ ] login
[ ] register when appropriate
[ ] session survives reload
[ ] model list loads
[ ] API key creation works
[ ] newly created key is shown once and then masked
[ ] chat request reaches the model and streams a response
[ ] user message persists
[ ] assistant message persists
[ ] refresh and reopen conversation
[ ] create a new conversation
[ ] delete a conversation
[ ] Usage page loads
[ ] Account page loads
[ ] password change flow, when enabled, works
```

Do not paste API-key values, passwords, or production secrets into logs or chat.

## Phase 8 — Portal logs only

```bash
docker logs --tail 200 hinaa-portal-backend
docker logs --tail 200 hinaa-portal-frontend
docker logs --tail 200 hinaa-portal-postgres
```

Do not alter unrelated stacks while investigating Portal logs.

## Rollback gate

Rollback only for material regressions such as:

- Portal frontend unavailable
- backend cannot start
- DB migration failure
- authentication broken by the release
- Portal chat cannot reach LiteLLM while the external LLM stack remains healthy
- destructive/corrupt application behavior

Known rollback filesystem baseline:

```text
~/llm-stack/hinaa-portal.backup-v0.1.3
```

A logical backup now exists as well, but a database restore has not yet been isolated/tested.

For database rollback, use a verified logical-backup procedure; never guess by deleting/reinitializing `postgres-data`.

## Forbidden routine operations

Never use these as routine Portal deployment steps:

```bash
docker compose down -v
docker system prune
docker volume prune
docker network prune
```

Never:

- overwrite `.env`
- delete/reinitialize `postgres-data`
- recreate the Portal database unnecessarily
- change public ports without an explicit architecture decision
- change Cloudflare routes
- create a second Cloudflare Tunnel
- modify vLLM / Qwen / H200 serving
- modify LiteLLM infrastructure
- modify ClearML
- modify Open WebUI
- modify unrelated Docker projects

When in doubt, inspect first and stop before executing a destructive command.
