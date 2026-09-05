# Hinaa User Portal v1

A Persian RTL user portal for Hinaa, kept separate from ClearML, LiteLLM, vLLM, and Open WebUI.

## Current architecture

Browser → Hinaa Portal → LiteLLM → vLLM → Qwen3-32B → H200

`chat.hinaa.ir` is intentionally untouched.

## Features in v1

- Persian RTL dark UI
- Register / login / logout
- User dashboard
- Streaming chat through LiteLLM
- Model discovery from LiteLLM
- User API key creation (LiteLLM Virtual Keys)
- Key masking, deletion
- Per-key model selection and RPM limit
- Usage lookup through LiteLLM `/key/info`
- Secure server-side storage of user API keys using Fernet encryption
- Master key never sent to the browser

## Deploy on the VPS

1. Copy this project to `~/llm-stack/hinaa-portal`.
2. Create `.env` from `.env.example` and set secrets.
3. Make sure the existing `litellm_default` Docker network exists.
4. Run:

```bash
docker compose up -d --build
```

5. Test:

```bash
curl -I http://127.0.0.1:3100
```

6. Cloudflare Tunnel route:

`panel.hinaa.ir` → `http://hinaa-portal-frontend:3000`

Before the route is used, connect `cloudflared` to the `hinaa_portal` network:

```bash
docker network connect hinaa_portal cloudflared
```

## Production notes

- Set `COOKIE_SECURE=true` behind HTTPS.
- Rotate any secrets that have ever been exposed.
- Add email verification, password reset, abuse protection, and billing before public launch.
- Keep `LITELLM_MASTER_KEY` backend-only.
