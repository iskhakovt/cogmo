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
| Channel-specific instructions | All in `steering_rules` with nullable `channel_type` scope | Single evolution surface for all behavioral instructions — global, profile-scoped, channel-scoped. Default channel rules seeded at channel setup. Observer can modify/graduate/consolidate like any other rule. Rejected `AdapterModule.promptGuidance` (static code, can't evolve without deploy, splits instructions across code + DB). See [transport/adapters.md](transport/adapters.md) → Response Rendering. |
| Adapter output rendering | Per-adapter `renderOutput(markdown)` → channel-ready content | LLM emits standard markdown (its strongest domain). Each adapter converts deterministically (Telegram → HTML subset, Slack → Block Kit, etc.). Rejected LLM-emitted HTML/MarkdownV2 (model drifts to unsupported constructs, tokens wasted, couples model to transport). |
| Telegram rendering library | `marked` + custom HTML post-processor | `marked` (v18, 33k⭐, 70M/wk, zero deps) parses GFM → HTML; ~100-line post-processor converts to Telegram's HTML subset. Rejected `@gramio/format` (entity-based: 0.x, silent failures on bad offsets, chunking requires offsets to be re-indexed, Telegram-only). Rejected `telegramify-markdown` (MarkdownV2 output, escape hell). Follows OpenClaw's battle-tested pattern (HTML parse mode, server-side table→`<pre>` conversion, emoji+bold preprocessing). |
| Control commands | Adapter-intercepted, no orchestrator | `/new`, `/sessions`, `/resume`, `/name`, `/end`, `/profile`, `/model` and similar handled by channel adapter directly via `Transport` admin methods. Never become inbound messages or Inngest events. Instant response, no LLM call. See [transport/adapters.md](transport/adapters.md) and [transport/telegram.md](transport/telegram.md). |
| Telegram library | grammY | TypeScript-first, 1.7M weekly npm downloads, actively maintained. Telegraf is older, heavier. node-telegram-bot-api unmaintained. |
| LLM routing | Direct SDKs + OpenRouter as a provider option | `LlmProvider` interface abstracts providers. Anthropic SDK for direct access; `OpenAICompatibleProvider` covers OpenRouter, OpenAI, xAI, and any Chat-Completions endpoint. User chooses provider at setup time. See [providers.md](providers.md). |
| Credential storage | Encrypted DB rows, not env | Runtime mutable, hot-swappable, backup-safe, wizard writes DB not files. Env vars as fallback for dev/CI. See [infrastructure.md](infrastructure.md) → Secrets. |
| Encryption library | `@noble/ciphers` + `@noble/hashes` | Cure53-audited (Sep 2024), stateless API eliminates `node:crypto`'s call-order footguns. HKDF for purpose separation. See [infrastructure.md](infrastructure.md). |
| Provider data model | `model_providers` routing table, no profile FK | Provider routing is a system-level concern (not per-profile). `model_providers` maps models to providers with position-based priority. Profile's `model` field stays a plain string — decoupled from infrastructure. See [providers.md](providers.md). |
| Setup UX | CLI wizard (agent handles user facts) | Ecosystem consensus (OpenClaw, Letta, GPT Builder): wizards handle infrastructure, agents learn user facts via conversation. `@clack/prompts` for TUI. See [setup.md](setup.md). |
| Async LLM costs | Batch APIs for evolution tasks | Anthropic, OpenAI, Gemini all offer 50% discount batch APIs (24h turnaround). Stacks with prompt caching (up to 95% off). Use for reflection, signal extraction, prompt optimization — anything that can wait. Interactive chat stays on real-time API. |
| Message history | Single `messages` table, `content` as `ContentBlock[]` jsonb | Industry consensus (Vercel AI SDK, Mastra, LangChain, Pydantic AI): one row per LLM turn, full block array in jsonb, role stays `user`/`assistant`. Mirrors Anthropic SDK's native shape — `getHistory()` feeds directly into `messages.create()` with zero reconstruction. Rejected: parent + child `tool_calls` table (only pays off for SQL-level tool analytics — Hindsight handles that); OpenAI Assistants-style Thread/Run/RunStep (overkill for single-user). |
| Message ordering | UUIDv7 `ORDER BY id`, no `turn_index` column | Inngest concurrency key on `conversationId` guarantees single writer. Sequential `uuidv7()` calls in the same Node.js process always increment monotonically (spec mandates counter/random increment within same ms tick). `turn_index` is belt-and-suspenders for concurrent writers — a scenario we've designed against. Add it only if we relax the single-writer constraint, in that same PR. |
| Image generation | Vercel AI SDK `generateImage()` + `@ai-sdk/fal` | No standard image gen API (unlike text LLMs). AI SDK covers 12+ providers, zero adapter code. Image gen is simple request/response — no streaming, caching, or token counting needed. Own `ImageProvider` interface would replicate what the SDK already does. See [image-generation.md](image-generation.md). |
| AI SDK scope | Image gen only, not text LLMs | Text LLMs need `countTokens` (AI SDK PR #12176 open, not merged), thinking block signature preservation (bug #11602), and our canonical `ContentBlock` types mirror Anthropic natively. Keep raw `LlmProvider` wrappers. Revisit when blockers resolve. |
| Sandbox backend selection | One backend per process, `SANDBOX_BACKEND` env (`local-docker` default, `daytona` opt-in) | A single Cogmo deployment runs exactly one backend — selection is process-wide, not per-task. Per-task backend selection would force every consumer (orchestrator, skills runner, future MCP sandboxer) to disambiguate at every call, and break the discriminated `SandboxSessionState` round-trip through Postgres. The capability flag (`workingTreeTransport`, `siblingContainers`, etc.) carries the cross-cutting differences without process-level coupling. See [sandbox.md](sandbox.md) → Backend selection. |
| Working-tree transport | Capability flag (`bind-mount` vs `git-remote`), branch at orchestrator | Bind-mount works on Local-Docker (kernel namespace makes it free); managed sandboxes don't accept arbitrary host mounts, but they DO accept git pulls, and every major AI coding agent (Codex, Cursor, Devin, Codespaces, Replit) uses git as transport. Native delta compression on push/fetch matters for repos > 100MB; no inbound-network requirement; no bespoke tar/upload code. The orchestrator branches on `sandbox.capabilities.workingTreeTransport` once at `allocate-worktree` time; everything downstream is identical. See [sandbox.md](sandbox.md) → Working-tree transport. |
| Run-branch cleanup | Hybrid: event-driven primary + weekly cron safety-net | Industry pattern across Renovate, Dependabot, GitHub-native, off-the-shelf stale-branch-action. Pure-cron loses the 99% case to a 7-day debt window; pure-event-driven misses crashes between status set and event emit. Hybrid catches both at the same complexity cost (one shared `deleteRunBranch` helper). Cron uses `step.sendEvent` fan-out per repo so per-repo failures get their own retry lane. See [sandbox.md](sandbox.md) → Orphan branch cleanup. |
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
| NanoClaw | Channel registry, cursor-based crash recovery, drift-resistant scheduling, activity-based timeouts, ~~internal tag stripping~~ (removed — thinking blocks + tool calls suffice), orchestrator-holds-secrets |
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
