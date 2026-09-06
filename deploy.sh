#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")"

BACKUP_DIR="${HOME}/llm-stack/hinaa-portal-backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

MODE=""
ROLLBACK_TAG=""

DEPLOY_SUCCESS=0

log() {
  printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  ./deploy.sh --check
  ./deploy.sh --backup
  ./deploy.sh --deploy
  ./deploy.sh --rollback <tag>

Examples:
  ./deploy.sh --check
  ./deploy.sh --backup
  ./deploy.sh --deploy
  ./deploy.sh --rollback v0.4.0-infra-stable
USAGE
  exit 1
}

cleanup_on_exit() {
  if [[ "${DEPLOY_SUCCESS}" != "1" && "${MODE}" == "deploy" ]]; then
    printf '\nDeployment did not complete successfully.\n' >&2
    printf 'No automatic rollback was performed.\n' >&2
    printf 'Inspect with: docker compose ps\n' >&2
    printf 'Logs: docker compose logs --tail 100 backend frontend\n' >&2
  fi
}

trap cleanup_on_exit EXIT

case "${1:-}" in
  --check)
    MODE="check"
    ;;
  --backup)
    MODE="backup"
    ;;
  --deploy)
    MODE="deploy"
    ;;
  --rollback)
    MODE="rollback"
    ROLLBACK_TAG="${2:-}"
    [[ -n "$ROLLBACK_TAG" ]] || usage
    ;;
  *)
    usage
    ;;
esac

[[ -f .env ]] || fail ".env is missing."
[[ -f docker-compose.yml ]] || fail "docker-compose.yml not found."

if [[ -d .git ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Git working tree is not clean. Commit changes before deployment."
  fi
fi

if [[ "$MODE" == "rollback" ]]; then
  git rev-parse --verify "refs/tags/${ROLLBACK_TAG}^{commit}" >/dev/null 2>&1 \
    || fail "Git tag not found: ${ROLLBACK_TAG}"

  CURRENT_COMMIT="$(git rev-parse HEAD)"
  TARGET_COMMIT="$(git rev-list -n 1 "${ROLLBACK_TAG}")"

  log "Rollback target"
  printf 'Current: %s\n' "$CURRENT_COMMIT"
  printf 'Target: %s (%s)\n' "$TARGET_COMMIT" "$ROLLBACK_TAG"

  [[ "$CURRENT_COMMIT" != "$TARGET_COMMIT" ]] \
    || fail "Target tag is already the current commit."
fi

mkdir -p "$BACKUP_DIR"

log "Checking compose configuration"
docker compose config >/dev/null

log "Checking required services"
for service in postgres backend frontend; do
  docker compose config --services | grep -qx "$service" \
    || fail "Required service missing: $service"
done

if [[ "$MODE" == "check" ]]; then
  log "Checking current service state"
  docker compose ps

  log "Checking local frontend"
  curl -fsS --max-time 5 \
    http://127.0.0.1:3100 \
    >/dev/null \
    || fail "Local frontend is not responding"

  log "Checking backend health"
  docker exec hinaa-portal-backend \
    python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5)' \
    >/dev/null \
    || fail "Backend health check failed"

  log "Checking Alembic"
  docker compose exec -T backend alembic current

  log "Checking public panel"
  PUBLIC_CODE="$(
    curl -sS \
      --max-time 10 \
      -o /dev/null \
      -w '%{http_code}' \
      https://panel.hinaa.ir || true
  )"

  [[ "$PUBLIC_CODE" == "200" ]] \
    || fail "Public panel returned HTTP ${PUBLIC_CODE}"

  DEPLOY_SUCCESS=1
  printf '\nPreflight check passed.\n'
  exit 0
fi

log "Creating PostgreSQL backup"
BACKUP_FILE="${BACKUP_DIR}/hinaa-pre-${MODE}-${STAMP}.dump"

docker exec hinaa-portal-postgres \
  pg_dump -U hinaa -d hinaa -Fc \
  > "$BACKUP_FILE"

chmod 600 "$BACKUP_FILE"

[[ -s "$BACKUP_FILE" ]] || fail "PostgreSQL backup is empty"

printf 'Backup: %s\n' "$BACKUP_FILE"

if [[ "$MODE" == "backup" ]]; then
  DEPLOY_SUCCESS=1
  printf '\nBackup completed successfully.\n'
  exit 0
fi

BUILD_DIR=""

if [[ "$MODE" == "rollback" ]]; then
  BUILD_DIR="$(mktemp -d)"

  cleanup_build_dir() {
    [[ -n "$BUILD_DIR" ]] && rm -rf "$BUILD_DIR"
  }

  trap cleanup_build_dir EXIT

  log "Checking out rollback tag into temporary worktree"

  git worktree add --detach "$BUILD_DIR" "$ROLLBACK_TAG" >/dev/null

  cp .env "$BUILD_DIR/.env"

  cd "$BUILD_DIR"
else
  log "Using current Git working tree"
fi

log "Validating selected source"
docker compose config >/dev/null

log "Building backend and frontend"
docker compose build backend frontend

log "Starting PostgreSQL"
docker compose up -d postgres

log "Waiting for PostgreSQL"

for _ in $(seq 1 30); do
  if docker compose exec -T postgres \
      pg_isready \
      -U "${POSTGRES_USER:-hinaa}" \
      -d "${POSTGRES_DB:-hinaa}" \
      >/dev/null 2>&1
  then
    break
  fi

  sleep 1
done

docker compose exec -T postgres \
  pg_isready \
  -U "${POSTGRES_USER:-hinaa}" \
  -d "${POSTGRES_DB:-hinaa}" \
  >/dev/null 2>&1 \
  || fail "PostgreSQL did not become ready"

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

[[ "$PUBLIC_CODE" == "200" ]] \
  || fail "Public panel returned HTTP ${PUBLIC_CODE}"

log "Deployment status"
docker compose ps

DEPLOY_SUCCESS=1

printf '\nOperation completed successfully.\n'
printf 'Mode: %s\n' "$MODE"
printf 'Backup: %s\n' "$BACKUP_FILE"

if [[ "$MODE" == "rollback" ]]; then
  printf 'Rollback target: %s\n' "$ROLLBACK_TAG"
fi

printf 'Panel: https://panel.hinaa.ir\n'
