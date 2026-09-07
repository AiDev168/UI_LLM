# Hinaa Portal — Production Baseline & Incident Record

## Known-good Production Baseline

Date: 2026-09

Known-good production commit:

`df2937ad100b561a8429e162f104f9e346bcbae1`

Tag:

`v0.2.1-production-stable`

Branch:

`production-stable`

Remote:

`origin/production-stable`

## Production Architecture

- `panel.hinaa.ir` → Hinaa Portal
- `app.hinaa.ir` → ClearML
- `llm.hinaa.ir` → LiteLLM
- `chat.hinaa.ir` → Open WebUI
- Cloudflare Tunnel is already in use.
- Portal frontend: Next.js
- Portal backend: FastAPI
- Portal database: PostgreSQL
- LiteLLM has a separate PostgreSQL database.
- ClearML has its own MongoDB / Redis / Elasticsearch stack.
- vLLM serves Qwen3-32B on H200.

Existing services must not be replaced or rebuilt as part of Portal changes unless explicitly required.

## Incident Summary

A feature branch named:

`feature/v1-1-chat-history-usage-ui`

contained work intended to add persistent chat history and Usage UI.

The deployed Production database already contained:

- `conversations`
- `messages`

with the Production schema used by the running database.

However, the deployed backend did not expose the corresponding conversation and usage endpoints.

The feature branch later contained reconciliation commits, but its final `backend/app/main.py` still did not contain:

- `/conversations`
- `/conversations/{conversation_id}`
- `/conversations/{conversation_id}/messages`
- `/usage`

Therefore the feature branch must not be merged wholesale into Production.

## Corrective Action

Production backend was reconciled against the existing database schema without destructive DB changes.

Implemented endpoints:

- `GET /conversations`
- `POST /conversations`
- `GET /conversations/{conversation_id}`
- `DELETE /conversations/{conversation_id}`
- `POST /conversations/{conversation_id}/messages`
- `GET /usage`

The existing tables were preserved.

## Performance Fix

Initial Portal loading was unnecessarily calling LiteLLM `/key/info` for every Portal API key.

This caused slow page loading.

The Portal was changed so:

- `/api-keys` does not perform LiteLLM usage calls during normal page load.
- `/dashboard` does not perform LiteLLM usage calls during normal page load.
- `/usage` performs usage aggregation separately.
- Usage requests are handled concurrently.
- A stale/missing LiteLLM key does not break the entire Usage endpoint.

## Known Data Condition

One historical Portal key exists in the Portal database but is no longer present in LiteLLM and therefore returns HTTP 404 from `/key/info`.

This is handled gracefully and is not treated as database corruption.

## Security Rules

- LiteLLM Master Key must remain backend-only.
- Customer API keys are LiteLLM virtual keys.
- Open WebUI API keys must not be used as customer Portal API keys.
- `.env` must never be committed.
- `postgres-data/` must never be committed.
- Secrets must never be placed in frontend source or browser-visible code.

## Backup State

A logical PostgreSQL backup exists outside the repository.

The backup was created with `pg_dump`.

A restore test is not yet documented as completed.

## Git Policy Going Forward

- `production-stable` is the known-good deployment branch.
- Production changes must have a specific Git commit.
- Production milestones should be tagged.
- Feature branches must be compared against Production before merge.
- Backend/schema changes require explicit reconciliation.
- No blind merge from feature branches into Production.
- No destructive database changes during routine Portal deployment.

## Current Principle

Repository truth and running Production truth must both be checked before deployment.

Database schema must never be inferred from a feature branch.

Production rollback must target a known Git commit/tag, not an untracked ZIP or ambiguous filesystem state.
