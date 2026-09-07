# TaHa / Hinaa Portal — Production Architecture

## Public Entry Point

https://panel.hinaa.ir

## Portal Components

- Next.js Frontend
- FastAPI Backend
- PostgreSQL 17
- Alembic
- LiteLLM integration

## Production Containers

| Service | Container | Internal | Host |
|---|---|---:|---:|
| Frontend | hinaa-portal-frontend | 3000 | 3100 |
| Backend | hinaa-portal-backend | 8000 | not published |
| PostgreSQL | hinaa-portal-postgres | 5432 | not published |

## Request Flow

Browser
  -> Cloudflare Tunnel
  -> panel.hinaa.ir
  -> Portal Frontend
  -> /api/*
  -> Portal Backend
  -> LiteLLM
  -> vLLM
  -> Qwen3-32B

## External Infrastructure

The following services are outside normal Portal deployment lifecycle:

- ClearML
- LiteLLM
- vLLM
- Open WebUI
- cloudflared

They must not be restarted or modified as part of ordinary Portal deployment or rollback unless explicitly required.

## Current Database Migration Baseline

53ccaaff04df

## Database Policy

Application rollback does not perform database downgrade.

Production database restoration is a separate controlled operation based on a verified PostgreSQL dump.

## Secret Policy

The following must never be committed to Git:

- .env
- LITELLM_MASTER_KEY
- JWT_SECRET
- FERNET_KEY
- customer API keys
- Cloudflare Tunnel token
- GitHub credentials
