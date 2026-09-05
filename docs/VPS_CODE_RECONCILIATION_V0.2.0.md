# VPS vs GitHub Feature Branch Reconciliation — v0.2.0

**Status:** safety gate before any Portal deployment
**Server:** `/home/zoneroot/llm-stack/hinaa-portal`
**GitHub branch:** `feature/v1-1-chat-history-usage-ui`

## 1. Verified server state

The current Portal Compose project is `hinaa-portal` with:

- `hinaa-portal-frontend`
- `hinaa-portal-backend`
- `hinaa-portal-postgres`

Current health checks verified on the VPS:

```text
frontend host :3100 -> HTTP 200
panel.hinaa.ir -> HTTP 200
backend /openapi.json from inside container -> HTTP 200
postgres -> healthy
```

The Portal source directory is **not a Git worktree**.

## 2. Current server source is not the GitHub feature branch

The current VPS source tree contains:

```text
backend/app/main.py
backend/Dockerfile
backend/README.md
backend/requirements.txt
frontend/app/globals.css
frontend/app/layout.tsx
frontend/app/page.tsx
frontend/Dockerfile
frontend/.dockerignore
frontend/next.config.ts
frontend/package.json
frontend/README.md
```

The feature branch contains additional Portal files that are absent from the VPS source tree, including:

```text
backend/app/portal.py
backend/app/conversations.py
frontend/app/portal.tsx
frontend/app/portal.css
```

Therefore the current running server must not be described as running the feature branch.

## 3. Important contradiction discovered during reconciliation

The running server backend imports only `app.main`, but its runtime route inventory already contains:

```text
GET    /conversations
POST   /conversations
GET    /conversations/{conversation_id}
DELETE /conversations/{conversation_id}
POST   /conversations/{conversation_id}/messages
GET    /usage
```

This means the currently deployed `main.py` already exposes conversation and usage endpoints even though the expected newer feature-branch modules are absent from the server filesystem.

The live PostgreSQL schema also contains:

```text
public.conversations
public.messages
```

## 4. Critical schema mismatch to avoid

The repository-side `backend/app/conversations.py` on the current feature branch defines a message table named:

```text
conversation_messages
```

with an additional `sequence` column.

The running Portal database instead has:

```text
messages
```

with token accounting columns:

```text
prompt_tokens
completion_tokens
total_tokens
```

Therefore **the feature-branch conversation module must not be deployed blindly**. It could create a parallel `conversation_messages` table and diverge from the existing production schema.

Before any application deployment or migration, reconcile the feature-branch implementation against the running schema and current `main.py` endpoints.

## 5. Current database backup

A real PostgreSQL custom-format dump was successfully created from the live Portal DB:

```text
~/llm-stack/hinaa-portal-backups/hinaa-20260905T121617Z.dump
```

Observed size:

```text
8.9K
```

The file was non-empty and permissions were restricted to `600`. An isolated restore has not yet been performed.

## 6. Deployment gate

Until the reconciliation is complete:

```text
DO NOT run:
- docker compose build
- docker compose up -d
- database migration
- source overlay
```

The correct next step is code-level reconciliation:

```text
current VPS main.py
        +
current VPS DB schema
        +
GitHub feature branch implementation
        ↓
canonical Portal implementation
```

## 7. Safety boundary

This reconciliation concerns the Portal only. Do not modify as part of this work:

- vLLM / `qwen3-32b`
- H200 model serving
- LiteLLM / `litellm-postgres`
- Open WebUI
- ClearML stack
- Cloudflare Tunnel
- production `.env`
- `postgres-data`
- public ports outside an explicit architecture decision

## 8. Truth hierarchy

```text
Running server behavior > deployment assumptions
Running DB schema    > feature-branch schema assumptions
Repository code      > documentation assumptions
```
