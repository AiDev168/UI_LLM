# LLM Stack Hardening Notes

## LiteLLM

Public route:

    https://llm.hinaa.ir

Cloudflare Tunnel target:

    http://litellm:4000

Host binding:

    127.0.0.1:4000 -> 4000

Result:

- Direct Host exposure reduced.
- Cloudflare Tunnel remains functional.
- Portal -> LiteLLM remains functional.
- Open WebUI remains on the same Docker network.

## vLLM

Container:

    qwen3-32b

Image:

    vllm/vllm-openai:v0.28.0

Model:

    Qwen3-32B

Current Host binding:

    0.0.0.0:8000 -> 8000

Current runtime:

- Docker bridge network
- `IpcMode=host`
- NVIDIA GPU access enabled
- H200
- Model mounted read-only

Connectivity verified:

    LiteLLM -> vLLM = HTTP 200

    Host -> vLLM /health = OK

Direct public NAT test:

    94.184.93.4:8000
    No HTTP response observed during audit.

## Decision

vLLM network topology is intentionally unchanged for now.

Reason:

- Current production traffic is healthy.
- LiteLLM -> vLLM works.
- Public direct access was not observed.
- Recreating vLLM would reload Qwen3-32B and introduce avoidable downtime.

Future hardening option:

Move vLLM behind an internal Docker network and remove Host port publishing.

This requires a controlled vLLM restart and should be performed during a planned maintenance window.

## Security Rules

Do not expose:

- LiteLLM master key
- LiteLLM salt key
- Portal JWT secret
- Portal Fernet key
- Customer API keys

Do not modify:

- ClearML
- Open WebUI
- Cloudflare Tunnel routes

without an explicit infrastructure change plan.
