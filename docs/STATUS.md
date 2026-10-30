# DECCANXAI implementation status

Single source of truth for what exists. "Verified" means covered by automated tests that pass in this repository (`npm test`). Nothing here is claimed beyond that.

| # | Capability (spec section) | Status | Evidence / notes |
|---|---|---|---|
| 1 | OpenAI-compatible adapter: models, chat, streaming (§2, §12) | **Verified** | `provider-adapters` tests against a real HTTP test server: usage measured vs estimated, 401/429/5xx mapping, Retry-After, timeout, mid-stream disconnect, truncated stream |
| 2 | Native Anthropic / Gemini adapters (§2) | **Not built** | Use their OpenAI-compatible endpoints via the generic adapter meanwhile; not tested against live providers |
| 3 | Local servers (Ollama, vLLM, llama.cpp) (§3) | **Partial** | Work through the generic adapter by design; no live test run |
| 4 | Gateway API: chat, streaming, models, usage, router decisions, admin discover/probe (§12) | **Verified** | `gateway.test.ts` over real sockets + a real-process smoke run |
| 5 | Provider management API / webhooks / SDK (§12) | **Not built** | Providers are set via config file |
| 6 | Router: scoring, premium-first profile, capability/context/budget/breaker filters, retries, backoff, Retry-After, failover, score table logging (§2) | **Verified** | `router`, `scoring` tests incl. 400-scenario seeded property test that hard constraints are never outscored |
| 7 | Circuit breaker (§2) | **Verified** | `breaker.test.ts`, plus integration test |
| 8 | Model registry: discovered / configured / accessible / tested / unavailable (§9) | **Verified** | States change only via real calls; listing never grants access |
| 9 | Quality tiers | **Operator-supplied** | Tiers are judgements you configure, not measured benchmarks. No built-in ranking of providers is shipped |
| 10 | Task-complexity classification (§2) | **Not built** | Only explicit `task_class` / `requires` hints are honoured |
| 11 | Token ledger, measured vs estimated, budgets, alerts, hard stops (§3, §15) | **Verified (in-memory)** | Resets on restart; no persistent DB yet |
| 12 | Cost analytics | **Partial** | Estimated from operator-entered prices only; unpriced requests are counted, not treated as free. "Actual reported cost" not available |
| 13 | Credential vault (§8) | **Verified as a library; not wired in** | AES-256-GCM envelope encryption, rotation, tamper tests. Gateway currently reads keys from env vars |
| 14 | Gateway auth, admin role, rate limit, size limits, secret redaction (§14) | **Verified** | Fail-closed startup; log-leak tests |
| 15 | RBAC/tenants/OIDC/sessions, backup & restore (§14) | **Not built** | |
| 16 | Agent core, 15 agents, orchestration, checkpoints, verification gate (§4) | **Not built** | Design in the architecture doc |
| 17 | Local runtime: sandbox, terminal, files, permission levels, audit, e-stop (§5) | **Not built** | Highest-risk component; needs its own security review |
| 18 | Browser automation, computer-use (§5) | **Not built** | |
| 19 | Hardware/EDA module and capability registry (§6) | **Not built** | No simulation or synthesis result can be reported because none is run |
| 20 | Studio dashboard, 19 sections (§7) | **Not built** | Gateway admin endpoints are the data source it will use |
| 21 | Memory & context management (§13) | **Not built** | |
| 22 | Desktop app, installers, Helm (§16) | **Not built** | |
| 23 | Docker image / compose | **Written, not build-tested** | Could not be exercised in the authoring environment |
| 24 | CI workflow | **Written, not yet run** | |
| 25 | 1,000+ model endpoints | **Architecture only** | Registry has no hard-coded limits; reaching that scale needs aggregator/local endpoints and has not been demonstrated |

## Known limitations of what exists
- Failover for streams happens only before the first chunk; after data is delivered a failure is surfaced, never silently restarted on another model.
- Only text messages; `tools`, `response_format`, images are rejected with a clear 400 (not silently dropped).
- Token estimates (~4 chars/token) are used only when a provider reports no usage and are labelled `estimated`.
- Single process; rate limiter, ledger, breaker and registry state are in memory.
- Nothing has been run against live commercial providers in this repository; adapters are verified against a protocol-faithful test server only.
- No free-token or premium-model entitlement is provided or implied. Access depends entirely on credentials and quotas you legitimately hold.
