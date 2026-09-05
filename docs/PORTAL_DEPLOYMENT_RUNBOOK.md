# Hinaa Portal Deployment Runbook

This runbook is for `panel.hinaa.ir` only. It is designed to prevent accidental impact to the existing LLM/ClearML/Open WebUI infrastructure.

## Preconditions

Deployment target:

```text
/home/zoneroot/llm-stack/hinaa-portal
Compose project: hinaa-portal
```

Protected dependencies:

```text
qwen3-32b
litellm
litellm-postgres
open-webui
clearml-*
cloudflared
```

Protected data/secrets:

```text
/home/zoneroot/llm-stack/hinaa-portal/.env
/home/zoneroot/llm-stack/hinaa-portal/postgres-data
```

Do not replace either file/directory during an application overlay.

## Phase 0 — Read-only preflight

Run:

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

Stop here if any unrelated infrastructure unexpectedly changed state.

## Phase 1 — Logical database backup before schema/data changes

Only required when the release changes database schema/data or when operationally appropriate.

```bash
mkdir -p ~/llm-stack/hinaa-portal-backups

docker exec hinaa-portal-postgres sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > ~/llm-stack/hinaa-portal-backups/hinaa-$(date -u +%Y%m%dT%H%M%SZ).dump
```

Verify:

```bash
latest=$(ls -1t ~/llm-stack/hinaa-portal-backups/*.dump | head -1)
ls -lh "$latest"
file "$latest"
```

A dump file must exist and be non-empty before proceeding with a risky DB change.

For higher assurance, inspect the archive without restoring it:

```bash
pg_restore -l "$latest" | head -40
```

If `pg_restore` is not installed on the host, do not install packages merely for this check; use an approved PostgreSQL client environment instead.

## Phase 2 — Preserve the live environment

Never copy repository `.env` over the server `.env`.

Never delete or recreate `postgres-data`.

When deploying an artifact, extract it to a temporary directory first and overlay only application/config files intended for the release.

Before overlaying, save a local emergency copy of the current application source if an artifact deployment requires it:

```bash
cd ~/llm-stack
sudo cp -a hinaa-portal "hinaa-portal.predeploy-$(date -u +%Y%m%dT%H%M%SZ)"
```

This command copies the application tree, including existing data, and should only be used when enough disk space exists. It must not replace the established rollback baseline.

## Phase 3 — Build Portal only

From the Portal directory:

```bash
cd ~/llm-stack/hinaa-portal
docker compose build --pull
```

Do not run a global Docker prune. Do not build unrelated Compose projects.

## Phase 4 — Start/update Portal only

```bash
cd ~/llm-stack/hinaa-portal
docker compose up -d
```

This should operate on the `hinaa-portal` Compose project.

Do not run `docker compose down` against unrelated directories.

## Phase 5 — Immediate health checks

```bash
cd ~/llm-stack/hinaa-portal
docker compose ps
```

Expected Portal containers:

```text
hinaa-portal-frontend   Up
hinaa-portal-backend    Up
hinaa-portal-postgres   Up / healthy
```

Frontend host check:

```bash
curl -I http://127.0.0.1:3100
```

Public check:

```bash
curl -I https://panel.hinaa.ir
```

Backend check must be made from inside the backend container because host port `8000` belongs to vLLM:

```bash
docker exec hinaa-portal-backend \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/openapi.json').status)"
```

## Phase 6 — Authentication and Portal smoke tests

Perform these through the actual Portal UI/API without printing secrets:

```text
[ ] login
[ ] register (only when appropriate)
[ ] /me/session remains valid after reload
[ ] create API key
[ ] verify key is masked after initial reveal
[ ] verify model selector loads
[ ] send chat message
[ ] receive streamed model response
[ ] refresh and verify conversation persistence
[ ] open a previous conversation
[ ] delete a conversation
[ ] verify Usage page loads
[ ] verify Account page loads
```

Do not copy API-key values into logs, shell history, tickets, or chat.

## Phase 7 — Logs

Inspect only Portal logs first:

```bash
docker logs --tail 200 hinaa-portal-backend
docker logs --tail 200 hinaa-portal-frontend
docker logs --tail 200 hinaa-portal-postgres
```

Do not restart or modify LiteLLM/vLLM/ClearML/Open WebUI merely because a Portal log is being inspected.

## Rollback decision point

Rollback is appropriate when the new Portal release causes a material regression such as:

- frontend unavailable
- backend cannot start
- database migration failure
- authentication failure introduced by the release
- Portal Chat cannot reach LiteLLM while the existing LLM stack remains healthy
- destructive or corrupt application behavior

Do not start rollback merely because a non-blocking cosmetic issue exists.

## Rollback principle

The known rollback baseline is:

```text
~/llm-stack/hinaa-portal.backup-v0.1.3
```

This is a filesystem backup, not a verified PostgreSQL restore procedure.

Before any destructive rollback operation:

1. Capture current Portal logs.
2. Preserve the current application directory as an emergency copy when disk space permits.
3. Stop only the Portal Compose project if stopping is required.
4. Restore the application source from the approved rollback baseline.
5. Preserve/reconcile the `.env` deliberately; do not blindly overwrite it.
6. Do not delete live PostgreSQL data.
7. For database rollback, use a verified PostgreSQL backup/restore procedure rather than guessing from filesystem copies.
8. Restart only the Portal project.
9. Run all Phase 5 and Phase 6 smoke tests.

Because the existing filesystem rollback has not been restore-tested, a production database rollback must not be considered automatically safe until a real logical backup and isolated restore procedure have been verified.

## Emergency stop conditions

Stop the deployment immediately if a command would:

```text
- remove or reinitialize postgres-data
- expose or replace .env secrets
- change Cloudflare routes
- modify public ports unexpectedly
- alter vLLM configuration
- alter LiteLLM infrastructure
- alter ClearML
- alter Open WebUI
- modify Qwen model files
- prune Docker globally
```

When in doubt, do not execute the command. Inspect the exact Compose project, container, network, and path first.
