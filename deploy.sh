#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

MODE="${1:-}"
TAG="${2:-}"

COMPOSE="docker compose"
BACKUP_DIR="$HOME/llm-stack/hinaa-portal-backups"
HEALTH_URL="http://127.0.0.1:3100"
PUBLIC_URL="https://panel.hinaa.ir"
ROLLBACK_ROOT="/tmp/hinaa-rollback"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
  echo
  echo "ERROR: $*" >&2
  exit 1
}

require_clean_tree() {
  git diff --quiet || die "Git working tree has unstaged changes."
  git diff --cached --quiet || die "Git index has staged changes."
}

require_env() {
  [[ -f .env ]] || die ".env is missing. Refusing to continue."
  [[ "$(stat -c '%a' .env)" == "600" ]] || die ".env permissions must be 600."
}

compose_validate() {
  log "Validating Docker Compose"
  $COMPOSE config >/dev/null
  log "Compose validation passed"
}

required_services() {
  local services
  services="$($COMPOSE config --services)"
  for svc in postgres backend frontend; do
    echo "$services" | grep -qx "$svc" || die "Required service missing: $svc"
  done
}

wait_http() {
  local url="$1"
  local name="$2"
  local max="${3:-60}"

  for ((i=1; i<=max; i++)); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      log "$name OK"
      return 0
    fi
    sleep 2
  done

  die "$name failed: $url"
}

backup_db() {
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  local file
  file="$BACKUP_DIR/hinaa-$(date -u '+%Y%m%dT%H%M%SZ').dump"

  log "Reading PostgreSQL credentials from running container"
  local pg_user
  local pg_db

  pg_user="$($COMPOSE exec -T postgres sh -lc 'printf "%s" "$POSTGRES_USER"')"
  pg_db="$($COMPOSE exec -T postgres sh -lc 'printf "%s" "$POSTGRES_DB"')"

  [[ -n "$pg_user" ]] || die "POSTGRES_USER is empty in postgres container."
  [[ -n "$pg_db" ]] || die "POSTGRES_DB is empty in postgres container."

  log "Creating PostgreSQL backup"
  $COMPOSE exec -T postgres pg_dump \
    -U "$pg_user" \
    -d "$pg_db" \
    -Fc > "$file"

  chmod 600 "$file"
  log "Backup created: $file"
}

check_current() {
  log "Checking local frontend"
  wait_http "$HEALTH_URL" "Local frontend"

  log "Checking backend health"
  docker exec hinaa-portal-backend     python -c     'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5)'     >/dev/null
  log "Backend health OK"

  log "Checking Alembic"
  local current
  current="$($COMPOSE exec -T backend alembic current 2>/dev/null || true)"
  [[ -n "$current" ]] || die "Unable to read Alembic current revision."
  echo "$current"

  log "Checking public panel"
  curl -fsS --max-time 15 "$PUBLIC_URL" >/dev/null
  log "Public panel check passed"

  echo
  echo "Preflight check passed."
}

rollback_preflight() {
  local target_tag="$1"
  local worktree="$ROLLBACK_ROOT/${target_tag//\//_}-$(date +%Y%m%d%H%M%S)"

  rm -rf "$worktree"
  mkdir -p "$ROLLBACK_ROOT"

  log "Validating rollback tag: $target_tag"

  git rev-parse --verify "refs/tags/$target_tag" >/dev/null 2>&1 \
    || die "Tag not found: $target_tag"

  git worktree add --detach "$worktree" "$target_tag"

  cleanup_preflight() {
    git worktree remove --force "$worktree" >/dev/null 2>&1 || true
    rm -rf "$worktree"
  }
  trap cleanup_preflight RETURN

  cp .env "$worktree/.env"
  chmod 600 "$worktree/.env"

  cd "$worktree"

  log "Rollback source commit"
  git rev-parse --short HEAD

  log "Validating rollback compose"
  $COMPOSE config >/dev/null
  log "Rollback compose OK"

  log "Checking required services"
  required_services

  log "Checking Alembic compatibility"
  if [[ ! -f backend/alembic.ini ]]; then
    die "Rollback tag has no Alembic configuration."
  fi

  if grep -q 'create_all' backend/app/main.py; then
    die "Rollback tag contains Base.metadata.create_all(); refusing automatic rollback."
  fi

  log "Building rollback backend image"
  $COMPOSE build backend

  log "Building rollback frontend image"
  $COMPOSE build frontend

  log "Rollback preflight BUILD PASSED"
  log "No production services were started or restarted."

  cd "$APP_DIR"
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$worktree"
  trap - RETURN
}

deploy() {
  require_clean_tree
  require_env
  compose_validate
  required_services

  backup_db

  log "Building backend"
  $COMPOSE build backend

  log "Building frontend"
  $COMPOSE build frontend

  log "Starting PostgreSQL"
  $COMPOSE up -d postgres

  log "Starting backend"
  $COMPOSE up -d backend

  log "Waiting for backend"
  for i in $(seq 1 30); do
    if docker exec hinaa-portal-backend       python -c       'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)'       >/dev/null 2>&1
    then
      log "Backend health OK"
      break
    fi

    if [ "$i" -eq 30 ]; then
      die "Backend health check failed."
    fi

    sleep 2
  done

  log "Checking Alembic"
  $COMPOSE exec -T backend alembic current

  log "Starting frontend"
  $COMPOSE up -d frontend

  check_current
}

rollback() {
  local target_tag="$1"

  require_clean_tree
  require_env

  [[ -n "$target_tag" ]] || die "Usage: $0 --rollback <tag>"

  # CRITICAL:
  # Build and validate the rollback target BEFORE touching Production.
  rollback_preflight "$target_tag"

  log "Rollback preflight successful."

  # Only now create the production backup.
  backup_db

  log "Creating production rollback worktree"

  local worktree="$ROLLBACK_ROOT/prod-${target_tag//\//_}-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$ROLLBACK_ROOT"

  git worktree add --detach "$worktree" "$target_tag"

  cleanup_prod() {
    git worktree remove --force "$worktree" >/dev/null 2>&1 || true
    rm -rf "$worktree"
  }
  trap cleanup_prod RETURN

  cp .env "$worktree/.env"
  chmod 600 "$worktree/.env"

  cd "$worktree"

  log "Building verified rollback backend"
  $COMPOSE build backend

  log "Building verified rollback frontend"
  $COMPOSE build frontend

  log "Stopping ONLY Portal backend/frontend"
  $COMPOSE stop backend frontend || true

  log "Starting PostgreSQL"
  $COMPOSE up -d postgres

  log "Starting rollback backend"
  $COMPOSE up -d backend

  log "Checking rollback backend"
  $COMPOSE exec -T backend curl -fsS \
    http://127.0.0.1:8000/health >/dev/null

  log "Checking Alembic"
  $COMPOSE exec -T backend alembic current

  log "Starting rollback frontend"
  $COMPOSE up -d frontend

  log "Checking rollback frontend"
  wait_http "$HEALTH_URL" "Local frontend"

  log "Checking public panel"
  curl -fsS --max-time 15 "$PUBLIC_URL" >/dev/null

  echo
  echo "========================================"
  echo "ROLLBACK COMPLETED"
  echo "Tag: $target_tag"
  echo "Database was NOT downgraded."
  echo "========================================"

  cd "$APP_DIR"
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$worktree"
  trap - RETURN
}

case "$MODE" in
  --check)
    require_env
    compose_validate
    required_services
    check_current
    ;;

  --backup)
    require_env
    backup_db
    ;;

  --deploy)
    deploy
    ;;

  --rollback)
    rollback "$TAG"
    ;;

  *)
    cat <<USAGE
Usage:
  ./deploy.sh --check
  ./deploy.sh --backup
  ./deploy.sh --deploy
  ./deploy.sh --rollback <tag>
USAGE
    exit 1
    ;;
esac
