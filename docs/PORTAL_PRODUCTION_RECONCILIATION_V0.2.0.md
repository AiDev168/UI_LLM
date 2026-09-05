# Hinaa Portal Production Reconciliation — v0.2.0

**Date:** 2026-09-05  
**Scope:** `panel.hinaa.ir` / `hinaa-portal` only

## Verified production facts

The live VPS application at `/home/zoneroot/llm-stack/hinaa-portal` is not a Git worktree. The running backend image still starts with `uvicorn app.main:app` and the container contains only `app/main.py`.

The live API nevertheless already contains conversation and usage functionality inside `main.py`:

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

## Reconciliation rule

The repository feature branch must extend the existing `Conversation` / `Message` implementation rather than introduce a parallel persistence model.

The previously introduced branch-side `backend/app/conversations.py` defined a conflicting `conversation_messages` table and a `sequence` field. That design did not match the live production schema and has therefore been removed.

`backend/app/portal.py` may remain only as a thin compatibility entrypoint that imports the existing `app.main:app`; it must not introduce a second application or duplicate routes/models.

## Deployment safety

Do not deploy the branch until repository code has been reconciled with the verified production schema and API contract.

Do not delete or reinitialize:

- `postgres-data`
- Portal PostgreSQL database
- `.env`
- LiteLLM/vLLM/ClearML/Open WebUI/Cloudflare infrastructure

## Backup baseline

A verified custom-format PostgreSQL dump now exists on the VPS. It is readable/listable and contains the current Portal tables, constraints, indexes, and data entries.

An isolated restore test has not yet been performed.
