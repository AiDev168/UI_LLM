# PR Review Notes — Hinaa Portal v1.1

## Current state

The branch `feature/v1-1-chat-history-usage-ui` is a Portal-only refinement branch. It is evaluated against the verified `v0.2.0` runtime and must not be treated as permission to change the protected LLM/ClearML/Open WebUI infrastructure.

## Reconciliation completed

- Removed the conflicting `backend/app/conversations.py` persistence model.
- Removed the unnecessary `backend/app/portal.py` wrapper.
- Restored the Backend Dockerfile entrypoint to canonical `app.main:app`.
- Kept the frontend as a refinement layer over the existing backend API contract.
- Added explicit VPS operational baseline and deployment runbook.
- Added a production reconciliation record.
- Added repository CI for Python syntax validation and frontend build validation.
- Removed the repository screenshot that exposed an API key from the current tree.

## Frontend work completed

- Persistent conversation history UI with graceful fallback when the currently running API does not expose history endpoints.
- New/open/delete conversation flows.
- Streaming chat with abort/stop control.
- Edit-message workflow that resubmits the edited prompt without inventing a destructive message-delete API.
- Regenerate assistant response workflow.
- Copy controls for user/assistant messages.
- Safe client-side Markdown rendering for headings, lists, inline code, fenced code blocks, emphasis and links.
- Dark/light theme preference persisted in browser local storage.
- Responsive mobile navigation retained and refined.
- API-key lifecycle UI retained with disabled actions for revoked keys.
- Usage dashboard retained against the existing `/usage` and dashboard contract.

## Production contract retained

The existing backend remains responsible for:

- authentication/session
- API key lifecycle
- model discovery
- chat proxying through LiteLLM
- conversations/messages persistence where exposed by the running API
- usage summary

The existing PostgreSQL schema remains canonical:

```text
users
portal_keys
conversations
messages
```

The frontend does not create or migrate database tables.

## Remaining product validation

The remaining work is validation, not another architecture rewrite:

- run the frontend production build against the exact branch state
- run browser/E2E smoke tests on `panel.hinaa.ir`
- verify edit/regenerate behavior against the live conversation endpoints
- verify daily/monthly usage only to the extent supported by the existing gateway data contract
- add password-change controls only after the existing password API contract is verified

These items do not justify changes to the protected infrastructure stack.
