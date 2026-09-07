# TaHa Portal — GUI / API Budget Snapshot

## Snapshot

GUI stabilization + Admin API budget management.

## Included

- Authentication/Admin baseline
- Chat/API/MLOps permissions
- LiteLLM usage/spend reporting
- Admin API budget management UI
- API key spend/budget visibility
- Six themes:
  - Graphite
  - Light
  - Midnight
  - Ocean
  - Glass
  - Paper
- Page-flow/layout stabilization

## Validation

- Docker Compose validation: PASS
- Backend: RUNNING
- Frontend: RUNNING
- PostgreSQL: HEALTHY
- Backend health: PASS
- Alembic head: `7d2b9c4a1e10`
- Python syntax: PASS
- Next.js build artifact: PASS
- Public panel HTTP 200
- Public title: `TaHa | هوش مصنوعی`
- Admin budget route: PRESENT
- User usage route: PRESENT
- Admin budget UI: PRESENT
- Theme selector: PRESENT

## Not yet signed off

Final end-to-end token overspend/enforcement testing is intentionally deferred to the next phase.
