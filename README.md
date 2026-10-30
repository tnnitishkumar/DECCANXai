# DECCANXAI
**One Intelligence. Multiple Models. Autonomous Execution.**
DECCANX Semiconductor Engineering

An open-source multi-model AI gateway and router. **This is v0.1 alpha: the gateway, router, model registry, usage ledger and security primitives are implemented and tested. The agent framework, local runtime, EDA module and dashboard are not built yet.** See [docs/STATUS.md](docs/STATUS.md) for the honest, complete picture.

## What works today
- One OpenAI-compatible endpoint (`/v1/chat/completions`, streaming, `/v1/models`) in front of any OpenAI-compatible provider: hosted APIs you have keys for, or local servers (Ollama, vLLM, llama.cpp).
- A router that prefers higher-quality models (premium-first is configurable), but only among models proven accessible; it retries with backoff, honours `Retry-After`, fails over, and opens circuit breakers. Every decision is logged with its full score table.
- Budgets (tokens / cost / requests, per day or month) enforced as hard stops, with alerts at 80% and 100%.
- A usage ledger that separates **measured** from **estimated** tokens and never treats an unknown price as free.

## Run it
Requires Node >= 22.18. No `npm install` needed to run.
```bash
cp deccanxai.config.example.json deccanxai.config.json   # edit providers
cp .env.example .env                                      # set GATEWAY_*_KEYS and provider keys
set -a; . ./.env; set +a
node services/gateway/src/main.ts
```
Then follow `examples/curl.sh`. Models start as *configured*; call `/v1/admin/probe` for the ones you want used (a real 1-token request) before `"model":"auto"` will route to them.

Docker: `docker compose up --build` (written but not yet build-tested).

## Test
```bash
npm test             # 97 tests, no network or accounts needed
npm run typecheck    # needs typescript + @types/node
```

## Principles
No fabricated tokens, prices, balances or model access. No quota or authentication bypass. Free access exists only where a provider genuinely offers it to you, or via local models. Nothing is claimed until tested.

License: Apache-2.0.
