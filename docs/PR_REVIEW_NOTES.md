# PR Review Notes — Hinaa Portal v1.1

## Current state

The branch `feature/v1-1-chat-history-usage-ui` is a Portal-only refinement branch. It must be evaluated against the verified `v0.2.0` runtime rather than assuming the VPS already contains this branch.

## Reconciliation completed

- Removed the conflicting `backend/app/conversations.py` persistence model.
- Removed the unnecessary `backend/app/portal.py` wrapper.
- Restored the Backend Dockerfile entrypoint to canonical `app.main:app`.
- Kept the frontend refinement layer over the existing backend API contract.
- Added explicit VPS operational baseline and deployment runbook.
- Added a production reconciliation record.
- Added repository CI for Python syntax validation and frontend build validation.
- Removed the repository screenshot that exposed an API key from the current tree.

## Production contract retained

The existing backend remains responsible for:

- authentication/session
- API key lifecycle
- model discovery
- chat proxying through LiteLLM
- conversations/messages persistence
- usage summary

The existing PostgreSQL schema remains canonical:

```text
users
portal_keys
conversations
messages
```

The frontend must not create a second persistence model.

## Remaining product gaps

The branch is not yet a complete implementation of the full requested SaaS surface. The next feature work should address, with tests:

- markdown/code rendering in chat
- edit and regenerate interactions
- robust stream cancellation/error handling
- message-level token persistence using the existing token columns
- richer daily/monthly usage metrics where supported by the existing gateway data contract
- password-change UI and security UX
- dark/light theme support
- stronger responsive/mobile navigation
- end-to-end regression coverage

These are application/product tasks. They do not justify changes to the protected infrastructure stack.
