# Production Deployment Runbook

## Repository

Path: ~/llm-stack/hinaa-portal

Branch: production-stable

## Preflight

Run:

    ./deploy.sh --check

Expected checks:

- Docker Compose validation
- Frontend health
- Backend health
- Alembic current revision
- Public panel availability

Current Alembic baseline:

    53ccaaff04df

## Backup

Run:

    ./deploy.sh --backup

Backups are stored in:

    ~/llm-stack/hinaa-portal-backups

Format: PostgreSQL custom format (pg_dump -Fc)

Permissions: 600

## Normal Deployment

Run:

    ./deploy.sh --deploy

Production deployment must preserve PostgreSQL data and must not modify:

- ClearML
- LiteLLM
- vLLM
- Open WebUI
- cloudflared

Do not overwrite .env.
Do not delete postgres-data.
Do not use docker compose down routinely.

## Rollback

Run only with a verified Git tag:

    ./deploy.sh --rollback <verified-tag>

Rollback requirements:

1. Validate the target tag.
2. Build backend and frontend before changing Production.
3. Create a PostgreSQL backup.
4. Replace only backend and frontend.
5. Use --no-deps.
6. Never downgrade the database.
7. Never recreate or stop PostgreSQL as part of rollback.

Verified rollback release:

    v0.5.5-production-rollback

Commit:

    e571124

## Post-Deployment Verification

    docker compose ps

    docker exec hinaa-portal-backend python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5).read().decode())'

    curl -fsS http://127.0.0.1:3100 >/dev/null && echo "Frontend OK"

    curl -fsS --max-time 15 https://panel.hinaa.ir >/dev/null && echo "Public OK"

    docker inspect -f '{{.State.Status}}' hinaa-portal-postgres

Expected:

- Backend health OK
- Frontend OK
- Public OK
- PostgreSQL running

## Database Migrations

All future schema changes must use explicit Alembic revisions.

Do not reintroduce Base.metadata.create_all() into production startup.

## Secret Handling

Never commit:

- .env
- LITELLM_MASTER_KEY
- JWT_SECRET
- FERNET_KEY
- customer API keys
- Cloudflare Tunnel token
- GitHub credentials
