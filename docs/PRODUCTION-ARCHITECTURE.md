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
----------------------------------

---

## Production Request Flow

The public Hinaa services are exposed through Cloudflare Tunnel.

```text
Internet
   |
   v
Cloudflare Tunnel
   |
   +-- app.hinaa.ir
   |       |
   |       +--> clearml-webserver:80
   |
   +-- llm.hinaa.ir
   |       |
   |       +--> litellm:4000
   |
   +-- chat.hinaa.ir
   |       |
   |       +--> open-webui:8080
   |
   +-- panel.hinaa.ir
           |
           +--> hinaa-portal-frontend:3000
                         |
                         | /api/*
                         v
                  hinaa-portal-backend:8000
                         |
                         v
                    litellm:4000
                         |
                         v
              Qwen3-VL-30B-A3B-Instruct
                         |
                         v
                        vLLM
________________________________________
Cloudflare Tunnel Routes
Public hostname	Internal destination	Purpose
app.hinaa.ir	http://clearml-webserver:80	ClearML
llm.hinaa.ir	http://litellm:4000	LiteLLM API
chat.hinaa.ir	http://open-webui:8080	Open WebUI
panel.hinaa.ir	http://hinaa-portal-frontend:3000	Hinaa Portal
These routes are implemented by the Cloudflare Tunnel configuration and are not Docker Compose host-port mappings.
________________________________________
Hinaa Portal Frontend
The production frontend is a Next.js application.
Container:
hinaa-portal-frontend
Internal application port:
3000
The production Cloudflare route is:
panel.hinaa.ir
    |
    v
hinaa-portal-frontend:3000
The frontend uses the Next.js rewrite configuration for backend API requests:
/api/*
    |
    v
hinaa-portal-backend:8000
The frontend is built as a Next.js standalone application.
________________________________________
Hinaa Portal Backend
The backend is implemented with FastAPI and served by Uvicorn.
Container:
hinaa-portal-backend
Internal port:
8000
The backend proxies chat completion requests to LiteLLM.
Browser
  |
  v
Next.js frontend
  |
  v
FastAPI backend
  |
  v
LiteLLM
  |
  v
vLLM
________________________________________
Streaming Architecture
Chat completions use streaming responses.
The backend uses FastAPI StreamingResponse with:
Content-Type: text/event-stream
The response also explicitly disables HTTP buffering where supported:
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
The backend receives the upstream LiteLLM stream and forwards the byte stream to the frontend.
The frontend reads the response body incrementally and parses Server-Sent Events (SSE).
Assistant text is progressively rendered in the UI rather than waiting for the complete response.
The public request path is therefore:
panel.hinaa.ir
    |
    v
Cloudflare Tunnel
    |
    v
Next.js
    |
    v
FastAPI StreamingResponse
    |
    v
LiteLLM streaming API
    |
    v
vLLM
If progressive rendering stops working, buffering must be investigated at every layer rather than assuming the problem is in the React UI.
________________________________________
Long Response / Token Handling
The model deployment currently uses a context length of:
32768 tokens
The frontend calculates an adaptive output-token budget based on the estimated input size and reserves part of the context window for safety.
The frontend also supports continuation when the model terminates a streamed response with:
finish_reason = length
The continuation mechanism requests the remaining response and combines the streamed pieces into the final assistant message.
The implementation limits the number of automatic continuation requests to prevent an uncontrolled loop.
The final assistant response is persisted after streaming/continuation is complete.
________________________________________
Current Model Deployment
The production vLLM deployment currently serves:
Qwen3-VL-30B-A3B-Instruct
Current relevant vLLM settings include:
--max-model-len 32768
--max-num-seqs 8
--gpu-memory-utilization 0.90
The served model name is:
Qwen3-VL-30B-A3B-Instruct
________________________________________
Docker Networking
The Hinaa Portal services communicate using Docker service/container names rather than public DNS names for internal traffic.
Examples:
hinaa-portal-frontend:3000
hinaa-portal-backend:8000
litellm:4000
open-webui:8080
clearml-webserver:80
Public hostnames such as panel.hinaa.ir are used by external clients through Cloudflare Tunnel.
Internal containers should not be changed to use public Cloudflare hostnames for normal service-to-service communication unless there is a specific architectural reason.
________________________________________
Docker Build / DNS Troubleshooting
During the September 2026 production update, Docker image builds initially failed while resolving Docker Hub:
registry-1.docker.io
The VPS resolver was using:
192.168.18.1
and DNS queries returned:
Connection refused
The host resolver was temporarily configured to use:
1.1.1.1
8.8.8.8
After DNS resolution was restored, the following images built successfully:
hinaa-portal-backend
hinaa-portal-frontend
This issue was a host/DNS resolution problem and was not caused by the Cloudflare Tunnel routes.
________________________________________
Production Verification Procedure
Before publishing a production change to GitHub:
1.	Modify the source on the production VPS.
2.	Build the affected Docker images.
3.	Restart only the affected services.
4.	Verify the containers are running.
5.	Inspect the running container when source-level verification is required.
6.	Test the affected functionality through the real production hostname.
7.	Only after successful verification, commit the verified changes.
8.	Push the verified commit to GitHub.
For the portal streaming implementation, the minimum verification includes:
docker compose build frontend backend
docker compose up -d --no-deps backend frontend
docker compose ps
and verification of the backend streaming headers:
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
The production portal should then be tested through:
https://panel.hinaa.ir
________________________________________
Git Branch Policy
The production VPS is the source of truth.
The normal promotion flow is:
Production VPS
      |
      v
Verify
      |
      v
Commit on main
      |
      v
Push origin/main
      |
      v
Promote production-stable
Existing unrelated backup files and temporary scripts must not be included in production commits.
Do not use destructive commands such as:
git reset --hard
git clean -fd
to make the working tree appear clean unless the contents have been explicitly reviewed and are known to be disposable.
EOF

