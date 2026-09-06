#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

MODE="${1:-}"
TAG="${2:-}"

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

require_env() {
  [[ -f .env ]] || die ".env is missing."
  [[ "$(stat -c '%a' .env)" == "600" ]] || die ".env permissions must be 600."
}

require_clean_tree() {
  git diff --quiet || die "Git working tree has unstaged changes."
  git diff --cached --quiet || die "Git index has staged changes."
}

compose() {
  docker compose "$@"
}

wait_frontend() {
  local max="${1:-30}"

  for i in $(seq 1 "$max"); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      log "Frontend health OK"
      return 0
    fi
    sleep 2
  done

  die "Frontend health check failed."
}

wait_backend() {
  local max="${1:-30}"

  for i in $(seq 1 "$max"); do
    if docker exec hinaa-portal-backend \
      python -c \
      'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)' \
      >/dev/null 2>&1
    then
      log "Backend health OK"
      return 0
    fi
    sleep 2
  done

  die "Backend health check failed."
}

validate_compose() {
  log "Validating Docker Compose"
  compose config >/dev/null
  log "Compose validation passed"

  local services
  services="$(compose config --services)"

  for svc in postgres backend frontend; do
    echo "$services" | grep -qx "$svc" \
      || die "Required service missing: $svc"
  done
}

backup_db() {
  require_env

  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  local file pg_user pg_db

  file="$BACKUP_DIR/hinaa-$(date -u '+%Y%m%dT%H%M%SZ').dump"

  log "Reading PostgreSQL credentials from running container"

  pg_user="$(docker exec hinaa-portal-postgres sh -lc 'printf "%s" "$POSTGRES_USER"')"
  pg_db="$(docker exec hinaa-portal-postgres sh -lc 'printf "%s" "$POSTGRES_DB"')"

  [[ -n "$pg_user" ]] || die "POSTGRES_USER is empty."
  [[ -n "$pg_db" ]] || die "POSTGRES_DB is empty."

  log "Creating PostgreSQL backup"

  docker exec hinaa-portal-postgres \
    pg_dump -U "$pg_user" -d "$pg_db" -Fc > "$file"

  chmod 600 "$file"

  log "Backup created: $file"
}

check_current() {
  validate_compose

  log "Checking local frontend"
  wait_frontend

  log "Checking backend health"
  wait_backend

  log "Checking Alembic"
  docker exec hinaa-portal-backend alembic current

  log "Checking public panel"
  curl -fsS --max-time 15 "$PUBLIC_URL" >/dev/null

  log "Public panel check passed"

  echo
  echo "Preflight check passed."
}

rollback_preflight() {
  local target_tag="$1"
  local worktree="$ROLLBACK_ROOT/preflight-${target_tag//\//_}-$(date +%Y%m%d%H%M%S)"

  mkdir -p "$ROLLBACK_ROOT"
  rm -rf "$worktree"

  log "Validating rollback tag: $target_tag"

  git rev-parse --verify "refs/tags/$target_tag" >/dev/null 2>&1 \
    || die "Tag not found: $target_tag"

  git worktree add --detach "$worktree" "$target_tag" >/dev/null

  cp "$APP_DIR/.env" "$worktree/.env"
  chmod 600 "$worktree/.env"

  (
    cd "$worktree"

    log "Rollback source commit"
    git rev-parse --short HEAD

    log "Validating rollback compose"
    docker compose config >/dev/null
    log "Rollback compose OK"

    [[ -f backend/alembic.ini ]] \
      || die "Rollback tag has no Alembic configuration."

    if grep -q 'create_all' backend/app/main.py; then
      die "Rollback tag contains create_all(); refusing rollback."
    fi

    log "Building rollback backend image"
    docker compose build backend

    log "Building rollback frontend image"
    docker compose build frontend
  )

  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf "$worktree"

  log "Rollback preflight BUILD PASSED"
}

rollback() {
  local target_tag="$1"

  require_clean_tree
  require_env

  [[ -n "$target_tag" ]] || die "Usage: $0 --rollback <tag>"

  # Phase 1: isolated validation/build
  rollback_preflight "$target_tag"

  # Phase 2: DB backup only
  backup_db

  local worktree="$ROLLBACK_ROOT/production-${target_tag//\//_}-$(date +%Y%m%d%H%M%S)"

  mkdir -p "$ROLLBACK_ROOT"
  rm -rf "$worktree"

  # Save current production image IDs
  local old_backend old_frontend
  old_backend="$(docker inspect -f '{{.Image}}' hinaa-portal-backend)"
  old_frontend="$(docker inspect -f '{{.Image}}' hinaa-portal-frontend)"

  git worktree add --detach "$worktree" "$target_tag" >/dev/null

  cp "$APP_DIR/.env" "$worktree/.env"
  chmod 600 "$worktree/.env"

  log "Building verified rollback backend"

  (
    cd "$worktree"
    docker compose build backend
  )

  log "Building verified rollback frontend"

  (
    cd "$worktree"
    docker compose build frontend
  )

  restore_previous() {
    log "Rollback failed; restoring previous backend/frontend."

    docker tag "$old_backend" hinaa-portal-backend:latest || true
    docker tag "$old_frontend" hinaa-portal-frontend:latest || true

    (
      cd "$APP_DIR"
      compose up -d --no-deps --force-recreate backend frontend || true
    )

    wait_backend 30 || true
    wait_frontend 30 || true

    curl -fsS --max-time 15 "$PUBLIC_URL" >/dev/null 2>&1 || true
  }

  cleanup() {
    git worktree remove --force "$worktree" >/dev/null 2>&1 || true
    rm -rf "$worktree"
  }

  trap 'restore_previous; cleanup; exit 1' ERR

  # IMPORTANT:
  # Return to real Production directory before touching containers.
  cd "$APP_DIR"

  log "Replacing ONLY backend/frontend"

  compose up -d \
    --no-deps \
    --force-recreate \
    backend frontend

  log "Checking rollback backend"
  wait_backend 30

  log "Checking rollback frontend"
  wait_frontend 30

  log "Checking public panel"
  curl -fsS --max-time 15 "$PUBLIC_URL" >/dev/null

  log "Public panel check passed"

  # PostgreSQL must still be the original Production container.
  local pg_status
  pg_status="$(docker inspect -f '{{.State.Status}}' hinaa-portal-postgres)"

  [[ "$pg_status" == "running" ]] \
    || die "PostgreSQL is not running."

  trap - ERR
  cleanup

  echo
  echo "========================================"
  echo "ROLLBACK COMPLETED"
  echo "Tag: $target_tag"
  echo "Backend: replaced"
  echo "Frontend: replaced"
  echo "PostgreSQL: untouched"
  echo "Database: NOT downgraded"
  echo "========================================"
}

deploy() {
  require_clean_tree
  require_env
  validate_compose

  backup_db

  log "Building backend"
  compose build backend

  log "Building frontend"
  compose build frontend

  log "Starting backend/frontend only"
  compose up -d --no-deps backend frontend

  wait_backend 30
  wait_frontend 30

  log "Checking Alembic"
  docker exec hinaa-portal-backend alembic current

  log "Checking public panel"
  curl -fsS --max-time 15 "$PUBLIC_URL" >/dev/null

  log "Public panel check passed"

  echo
  echo "Deploy completed successfully."
}

case "$MODE" in
  --check)
    require_env
    check_current
    ;;

  --backup)
    backup_db
    ;;

  --deploy)
    deploy
    ;;

  --rollback)
    rollback "$TAG"
    ;;

  *)
    echo "Usage:"
    echo "  ./deploy.sh --check"
    echo "  ./deploy.sh --backup"
    echo "  ./deploy.sh --deploy"
    echo "  ./deploy.sh --rollback <tag>"
    exit 1
    ;;
esac
