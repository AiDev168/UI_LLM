# Hinaa Portal Production Reconciliation — v0.2.0

**Date:** 2026-09-05  
**Scope:** `panel.hinaa.ir` / `hinaa-portal` only

## Verified production facts

The live VPS application at `/home/zoneroot/llm-stack/hinaa-portal` is not a Git worktree. The running backend image starts with the canonical command:

```text
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The live backend container contains `app/main.py` as the application module. The live API already contains conversation and usage functionality in that module:

- `GET /conversations`
- `POST /conversations`
- `GET /conversations/{conversation_id}`
- `POST /conversations/{conversation_id}/messages`
- `DELETE /conversations/{conversation_id}`
- `GET /usage`

The live PostgreSQL schema contains:

- `public.users`
- `public.portal_keys`
- `public.conversations`
- `public.messages`

The live `messages` table includes `prompt_tokens`, `completion_tokens`, and `total_tokens`.

## Reconciliation decision

The canonical Portal persistence model is the existing `Conversation` / `Message` implementation in `backend/app/main.py`, matching the live production schema.

The previously introduced branch-side `backend/app/conversations.py` defined a conflicting `conversation_messages` table and a `sequence` field. That design did not match production and has been removed from the feature branch.

The previously added `backend/app/portal.py` compatibility wrapper has also been removed. The backend Docker image now uses the canonical `app.main:app` entrypoint, matching the current production runtime.

## Frontend boundary

The feature branch may replace/refactor the frontend implementation for `panel.hinaa.ir`, but its API calls must remain compatible with the existing backend contract unless a deliberate, tested backend change is made.

Conversation persistence must continue to use:

```text
/conversations
/conversations/{conversation_id}
/conversations/{conversation_id}/messages
```

Token accounting fields must remain compatible with the existing `messages` schema.

## Deployment safety

Do not deploy a branch state that introduces a second persistence model or attempts to reinitialize the current database.

Do not delete or reinitialize:

- `postgres-data`
- Portal PostgreSQL database
- `.env`
- LiteLLM/vLLM/ClearML/Open WebUI/Cloudflare infrastructure

## Current backup

A real PostgreSQL custom-format logical backup was created from the live Portal database:

```text
~/llm-stack/hinaa-portal-backups/hinaa-20260905T121617Z.dump
```

The archive was successfully enumerated and contains the current Portal tables, data entries, primary keys, indexes, and foreign keys.

An isolated restore test has not yet been performed.

## Deployment gate

Before the next production deployment, the feature branch must pass repository CI and the VPS smoke-test procedure in `docs/PORTAL_DEPLOYMENT_RUNBOOK.md`.

The next deployment is Portal-only. It must not rebuild, restart, or reconfigure unrelated Compose projects.

## Truth hierarchy

```text
Running server behavior > deployment assumptions
Running DB schema    > feature-branch schema assumptions
Repository code      > documentation assumptions
```
