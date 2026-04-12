# Decisions

## Decision Table `[confirmed]`

| Decision | Choice | Rationale |
|-|-|-|
| Framework | None (raw `anthropic` SDK) | ~30 line agentic loop. LangGraph's immutable compiled graph incompatible with self-evolution. LangChain sentiment brutally negative. |
| Language | TypeScript (Node.js) | Tier 1 SDK support across providers, real types, 60-70% of YC X25 agent startups chose TS. Node over Bun (memory leaks). |
| Topology | Layered hub-and-spoke | 4.4x error rate with orchestrator vs 17.2x without. Peer mesh: 0 production successes. |
| Memory | Hindsight (self-hosted server) + Observer | 91.4% LongMemEval, PostgreSQL-native, HTTP client SDK, MCP. Post-conversation extraction bypasses 15% silent failure rate. |
| Self-evolution | 6-stage ladder | Each stage complete and useful alone. Data thresholds gate progression. |
| Orchestration | Inngest (self-hosted) | Event-driven durable execution. Native `step.waitForEvent()` for HITL, built-in cron/queues, `step.ai.infer()` for LLM calls, AgentKit for multi-agent. SSPL license (fine for personal use). Connect + Checkpointing gives ~2ms per step. |
| Prompt optimization | Build own (7 patterns) | Core loop ~50-100 lines TS. DSPy: Python. Ax: API churn (348 npm releases). |
| Model strategy | Hybrid: subscription CLI + per-token API | Background tasks via `claude -p` ($0). Interactive via API (~$80-200/mo). |
| Interface | Telegram first, adapter pattern | Messenger is transport. Telegram first (existing usage). Adapter pattern for CLI/Discord/API. |
| Response rendering | Agent returns markdown, adapters render | Researched MS Bot Framework (Activity model), Adaptive Cards, Botpress content types. Industry consensus across all AI agent frameworks (Letta, OpenClaw, Dust, Vercel AI SDK, LangChain): agent outputs text/markdown, adapters handle platform rendering. No rich intermediate representation. |
| Control commands | Adapter-intercepted, no orchestrator | `/new`, `/profile`, `/settings` handled by channel adapter directly via domain services. Never become inbound messages or Inngest events. Instant response, no LLM call. |
| Telegram library | grammY | TypeScript-first, 1.7M weekly npm downloads, actively maintained. Telegraf is older, heavier. node-telegram-bot-api unmaintained. |
| LLM routing | Direct SDKs + OpenRouter as a provider option | `LlmProvider` interface abstracts providers. Anthropic SDK for direct access; `OpenAICompatibleProvider` covers OpenRouter, OpenAI, xAI, and any Chat-Completions endpoint. User chooses provider at setup time. See [providers.md](providers.md). |
| Credential storage | Encrypted DB rows, not env | Runtime mutable, hot-swappable, backup-safe, wizard writes DB not files. Env vars as fallback for dev/CI. See [infrastructure.md](infrastructure.md) → Secrets. |
| Encryption library | `@noble/ciphers` + `@noble/hashes` | Cure53-audited (Sep 2024), stateless API eliminates `node:crypto`'s call-order footguns. HKDF for purpose separation. See [infrastructure.md](infrastructure.md). |
| Provider data model | `model_providers` routing table, no profile FK | Provider routing is a system-level concern (not per-profile). `model_providers` maps models to providers with position-based priority. Profile's `model` field stays a plain string — decoupled from infrastructure. See [providers.md](providers.md). |
| Setup UX | CLI wizard (agent handles user facts) | Ecosystem consensus (OpenClaw, Letta, GPT Builder): wizards handle infrastructure, agents learn user facts via conversation. `@clack/prompts` for TUI. See [setup.md](setup.md). |
| Async LLM costs | Batch APIs for evolution tasks | Anthropic, OpenAI, Gemini all offer 50% discount batch APIs (24h turnaround). Stacks with prompt caching (up to 95% off). Use for reflection, signal extraction, prompt optimization — anything that can wait. Interactive chat stays on real-time API. |
| Personal agents | Build own | No existing tool covers memory + agent runtime + evolution together. |
| Team tool | Dust.tt or Onyx | Separate from personal bot. Dust: $315/mo, 88% DAU. Onyx: MIT, self-hosted. |

## Eliminated Options `[confirmed]`

| Tool | Category | Why eliminated |
|-|-|-|
| LangGraph | Framework | Immutable compiled graph can't self-evolve at runtime |
| LangChain | Framework | Universally negative developer sentiment, abstraction overhead |
| Pydantic AI | Framework | Lags provider features by weeks, 70+ releases in 6 months |
| Mastra | Framework | Graduation path only — revisit if plumbing > ~500 lines |
| DSPy | Prompt opt | Python-only, wrong language |
| Ax | Prompt opt | 348 npm releases (API churn), bus factor |
| BullMQ | Orchestration | No durable execution — crash mid-job = restart from scratch. No native event model, no HITL. Building durability on top is a known anti-pattern. |
| Temporal | Orchestration | Best durability guarantees but TS SDK requires sandboxed V8 (no normal Node.js APIs in workflows). Self-hosting is heavy (2-4GB server). TS SDK release cadence slowed (meta-package stuck since Feb 2024). Overkill for single-user assistant. |
| Trigger.dev | Orchestration | Self-hosting requires 4 cores + 8GB RAM minimum. Designed as managed platform; self-hosting explicitly "for evaluation only." |
| DBOS Transact | Orchestration | Library approach (no extra service), MIT license, PostgreSQL-only. But smallest community (1.1K stars, 17K npm/week vs Inngest's 289K). No native event model. Viable fallback if Inngest doesn't work out. |
| Restate | Orchestration | Excellent performance (single Rust binary, <100ms p99) but no built-in cron/scheduling, BSL license, smaller community. Would need a separate scheduler. |
| Hatchet | Orchestration | Pre-1.0 (v0.81), adds RabbitMQ dependency, rapidly changing API. |
| Windmill | Orchestration | Platform, not a library — architecture mismatch. 3+GB baseline. |
| Activepieces | Scheduling | 1.5GB baseline (revisit for MCP integrations) |
| Mem0 | Memory | No MCP, limited memory types |
| Graphiti | Memory | O(n) growth bug, Python-only |
| Letta | Memory | Oversized for personal use, was in AI agent sunset |
| LightRAG | Memory | Wrong scale — personal has thousands of facts, not millions of docs |
| OpenRouter | LLM routing | Adds 50-100ms latency + 5.5% markup. Useful for multi-provider A/B testing — keep as future `LlmProvider` implementation if needed. |
| PAI | Reference arch | 95% single-author, breaking changes every 2 weeks, 80% false-positive ratings |
| Peer mesh | Topology | 17x error amplification, 3-5x dev cost, 0 production deployments |

## Adopted Patterns

### From proven reference implementations `[confirmed]`

| Source | Patterns |
|-|-|
| NanoClaw | Channel registry, cursor-based crash recovery, drift-resistant scheduling, activity-based timeouts, internal tag stripping, orchestrator-holds-secrets |
| Mastra | Post-conversation Observer extraction, confidence-based network routing |

### From research papers — needs evaluation before adopting `[research]`

| Source | Patterns |
|-|-|
| NanoClaw | GroupQueue (per-entity FIFO) |
| memU | Salience scoring, route intention gate, tiered retrieval, tool performance tracking |
| DSPy MIPROv2 | Bootstrapped few-shot, instruction candidate generation with tip randomization |
| DSPy GEPA | Textual feedback in metrics, Pareto frontier, reflective mutation |
| Ax ACE | Playbook with delta edits (Generator/Reflector/Curator loop) |
| Voyager | Skill library (code + description separation, compositional skills) |
| DGM | Tree-structured archive, lineage tracing (safety lesson) |
| PAI | ISC decomposition, AI Steering Rules as DB rows, learning signal capture |
