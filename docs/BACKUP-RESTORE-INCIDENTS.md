# Backup, Restore and Incident History

## PostgreSQL Backup

Backup directory:

    ~/llm-stack/hinaa-portal-backups

Format:

    pg_dump -Fc

Permissions:

    600

Create a backup:

    ./deploy.sh --backup

## Backup Verification

Inspect backups:

    ls -lh ~/llm-stack/hinaa-portal-backups/

Check permissions:

    stat -c '%a %n' ~/llm-stack/hinaa-portal-backups/*.dump

## Restore Policy

Production database restore is not part of normal application rollback.

Before a real restore:

1. Preserve the current database with a new backup.
2. Select and verify the backup.
3. Restore into a temporary PostgreSQL instance.
4. Verify tables.
5. Verify row counts.
6. Verify foreign keys.
7. Verify Alembic revision.
8. Only then plan a Production restore.

## Restore Test

A PostgreSQL logical backup was previously restored into a temporary PostgreSQL 17 Alpine container.

Verified objects included:

- alembic_version
- users
- portal_keys
- conversations
- messages

Foreign-key integrity between:

    messages.conversation_id
        ->
    conversations.id

was verified.

The Production database was not restored during this test.

## Incident 1 — notify TypeScript Error

Error:

    TS2304: Cannot find name 'notify'

Cause:

`notify` existed in the parent component scope but was not passed to `Keys`.

Fix commit:

    54af624

    fix: pass notify callback to keys component

## Incident 2 — Missing public Directory

Error:

    COPY --from=builder /app/public ./public
    /app/public: not found

Cause:

The frontend project did not contain a `public` directory.

Fix:

    RUN mkdir -p /app/public

## Incident 3 — Wrong PostgreSQL Role

Error:

    FATAL: role "portal" does not exist

Cause:

The deployment script assumed the PostgreSQL role/database names.

Fix:

The script now reads:

    POSTGRES_USER
    POSTGRES_DB

from the running PostgreSQL container.

## Incident 4 — Rollback PostgreSQL Container Conflict

Error:

    Conflict. The container name "/hinaa-portal-postgres"
    is already in use

Cause:

A rollback worktree was accidentally treated as a separate Production Compose project.

Impact:

Backend/frontend were stopped during one test before the PostgreSQL conflict was detected.

Recovery:

    docker compose up -d postgres backend frontend

Production was restored successfully.

Final fix:

- worktree is used only for builds
- Production commands run from the real Portal directory
- rollback targets only backend/frontend
- `--no-deps` is used
- PostgreSQL is excluded from rollback

## Incident 5 — Backend curl Dependency

Initial health check tried to execute `curl` inside the backend container.

The backend image does not require curl.

Current health check uses Python:

    docker exec hinaa-portal-backend python -c     'import urllib.request; urllib.request.urlopen(
    "http://127.0.0.1:8000/health", timeout=5)'

## Incident 6 — Missing deploy.sh Dispatcher

A broken intermediate version of `deploy.sh` lost the `case "$MODE"` dispatcher.

Result:

    ./deploy.sh --check

returned without performing checks.

Resolution:

The deployment script was rebuilt as a single complete script and the dispatcher restored.

## Incident 7 — SSH Disconnect During Health Check

SSH sessions were interrupted while running Docker/health checks.

Production was verified afterward and remained healthy.

Current direct checks:

- Backend: OK
- Frontend: OK
- Public panel: OK
- PostgreSQL: running/healthy

## Final Verified State

Release:

    v0.5.5-production-rollback

Deployment script commit:

    e571124

Current documentation commit:

    3004aad
