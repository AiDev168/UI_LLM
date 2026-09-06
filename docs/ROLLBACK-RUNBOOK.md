# Production Rollback Runbook

## Purpose

Rollback must change only the Portal backend/frontend.

PostgreSQL must remain running and must not be recreated or downgraded.

## Verified Release

Current verified rollback release:

    v0.5.5-production-rollback

Commit:

    e571124

## Safe Sequence

1. Verify Git working tree is clean.
2. Verify `.env` exists and has mode 600.
3. Verify target Git tag exists.
4. Create an isolated worktree.
5. Validate Compose configuration.
6. Verify Alembic compatibility.
7. Build backend in the isolated worktree.
8. Build frontend in the isolated worktree.
9. Create PostgreSQL backup.
10. Record current backend/frontend image IDs.
11. Build the verified rollback target.
12. Return to the real Production directory.
13. Replace only `backend` and `frontend`.
14. Use `--no-deps`.
15. Check backend health.
16. Check frontend health.
17. Check public panel.
18. Verify PostgreSQL is still running.
19. Remove temporary worktree.

## Critical Commands

Production replacement must be equivalent to:

    docker compose up -d --no-deps --force-recreate backend frontend

The rollback must NOT execute:

    docker compose up -d postgres

The rollback must NOT:

- stop PostgreSQL
- recreate PostgreSQL
- delete `postgres-data`
- downgrade the database
- run an implicit Alembic downgrade

## Failure Recovery

The previous backend/frontend image IDs are saved before replacement.

If health checks fail:

1. Restore previous image IDs.
2. Recreate backend/frontend only.
3. Check backend health.
4. Check frontend health.
5. Check public panel.
6. Confirm PostgreSQL remains running.

## Database Policy

Application rollback and database rollback are separate operations.

A database restore requires:

- a verified PostgreSQL dump
- preservation of the current database state
- restore testing
- integrity verification
- an explicit maintenance decision

## Known Release History

The following tags were discovered during rollback validation and should not be treated as verified rollback targets without separate validation:

    v0.5.0-production-rollback
    v0.5.1-production-rollback
    v0.5.2-production-rollback
    v0.5.3-production-rollback
    v0.5.4-production-rollback

`v0.5.5-production-rollback` is the verified rollback release.

## Verification Performed

The verified release was tested on Production.

Successful checks:

- isolated backend build
- isolated frontend build
- PostgreSQL backup
- backend replacement
- frontend replacement
- backend health
- frontend health
- public panel
- PostgreSQL preservation
- no database downgrade
