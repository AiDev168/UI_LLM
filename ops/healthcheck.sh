#!/usr/bin/env bash
set -u

LOG_DIR="$HOME/llm-stack/hinaa-portal-backups"
LOG_FILE="$LOG_DIR/healthcheck.log"

mkdir -p "$LOG_DIR"

ts() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

failures=0

check() {
  local name="$1"
  shift

  if "$@" >/dev/null 2>&1; then
    echo "$(ts) OK    $name" >> "$LOG_FILE"
  else
    echo "$(ts) FAIL  $name" >> "$LOG_FILE"
    failures=$((failures + 1))
  fi
}

check "postgres-container" \
  docker inspect -f '{{.State.Status}}' hinaa-portal-postgres

check "postgres-health" \
  docker inspect -f '{{.State.Health.Status}}' hinaa-portal-postgres

check "backend-health" \
  docker exec hinaa-portal-backend \
  python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5)'

check "frontend-http" \
  curl -fsS --max-time 5 http://127.0.0.1:3100

check "public-panel" \
  curl -fsS --max-time 10 https://panel.hinaa.ir

check "litellm-container" \
  docker inspect -f '{{.State.Status}}' litellm

check "vllm-container" \
  docker inspect -f '{{.State.Status}}' qwen3-32b

check "vllm-health" \
  curl -fsS --max-time 5 http://127.0.0.1:8000/health

check "cloudflared-container" \
  docker inspect -f '{{.State.Status}}' cloudflared

chmod 750 ops/healthcheck.sh

echo "Health monitor created."
