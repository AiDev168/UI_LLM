#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

PROJECT_DIR="$(pwd)"
BACKUP_DIR="${HOME}/llm-stack/hinaa-portal-backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log() {
  printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

cleanup_on_exit() {
  if [[ "${DEPLOY_SUCCESS:-0}" != "1" ]]; then
    printf '\nDeployment did not complete successfully.\n' >&2
    printf 'Running containers were NOT automatically rolled back.\n' >&2
    printf 'Inspect with: docker compose ps\n' >&2
    printf 'Logs: docker compose logs --tail 100 backend frontend\n' >&2
  fi
}

trap cleanup_on_exit EXIT

[[ -f .env ]] || fail ".env is missing. Refusing to create or overwrite production credentials."
[[ -f docker-compose.yml ]] || fail "docker-compose.yml not found."

if [[ -d .git ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Git working tree is not clean. Commit changes before deployment."
  fi
fi

mkdir -p "$BACKUP_DIR"

log "Preflight: compose configuration"
docker compose config >/dev/null

log "Preflight: required services"
docker compose config --services | grep -qx "postgres" || fail "postgres service missing"
docker compose config --services | grep -qx "backend" || fail "backend service missing"
docker compose config --services | grep -qx "frontend" || fail "frontend service missing"

log "Creating PostgreSQL backup"
BACKUP_FILE="${BACKUP_DIR}/hinaa-pre-deploy-${STAMP}.dump"

docker exec hinaa-portal-postgres \
  pg_dump -U hinaa -d hinaa -Fc \
  > "$BACKUP_FILE"

chmod 600 "$BACKUP_FILE"
[[ -s "$BACKUP_FILE" ]] || fail "PostgreSQL backup is empty"

log "Backup created: $BACKUP_FILE"

log "Building images"
docker compose build backend frontend

log "Starting PostgreSQL"
docker compose up -d postgres

log "Waiting for PostgreSQL"
until docker compose exec -T postgres \
  pg_isready -U "${POSTGRES_USER:-hinaa}" \
  -d "${POSTGRES_DB:-hinaa}" >/dev/null 2>&1
do
  sleep 1
done

log "Starting backend"
docker compose up -d backend

log "Waiting for backend"
BACKEND_OK=0

for _ in $(seq 1 30); do
  if docker exec hinaa-portal-backend \
      python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)' \
      >/dev/null 2>&1
  then
    BACKEND_OK=1
    break
  fi
  sleep 1
done

[[ "$BACKEND_OK" == "1" ]] || {
  docker compose logs --tail 100 backend >&2
  fail "Backend health check failed"
}

log "Checking Alembic state"
docker compose exec -T backend alembic current

log "Starting frontend"
docker compose up -d frontend

log "Waiting for frontend"
FRONTEND_OK=0

for _ in $(seq 1 30); do
  if curl -fsS \
      --max-time 5 \
      http://127.0.0.1:3100 \
      >/dev/null 2>&1
  then
    FRONTEND_OK=1
    break
  fi
  sleep 1
done

[[ "$FRONTEND_OK" == "1" ]] || {
  docker compose logs --tail 100 frontend >&2
  fail "Frontend health check failed"
}

log "Smoke test: public panel"
PUBLIC_CODE="$(
  curl -sS \
    --max-time 10 \
    -o /dev/null \
    -w '%{http_code}' \
    https://panel.hinaa.ir || true
)"

[[ "$PUBLIC_CODE" == "200" ]] || \
  fail "Public panel returned HTTP ${PUBLIC_CODE}, expected 200"

log "Smoke test: backend health"
docker exec hinaa-portal-backend \
  python -c 'import urllib.request; r=urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5); print(r.read().decode())'

log "Deployment status"
docker compose ps

DEPLOY_SUCCESS=1

printf '\nDeployment completed successfully.\n'
printf 'Backup: %s\n' "$BACKUP_FILE"
printf 'Panel: https://panel.hinaa.ir\n'
