# Decisions

## Decision Table

| Decision | Choice | Rationale |
|-|-|-|
| Framework | None (raw `anthropic` SDK) | ~30 line agentic loop. LangGraph's immutable compiled graph incompatible with self-evolution. LangChain sentiment brutally negative. |
| Language | TypeScript (Node.js) | Tier 1 SDK support across providers, real types, 60-70% of YC X25 agent startups chose TS. Node over Bun (memory leaks). |
| Topology | Layered hub-and-spoke | 4.4x error rate with orchestrator vs 17.2x without. Peer mesh: 0 production successes. |
| Memory | Hindsight + Observer | 91.4% LongMemEval, PostgreSQL-native, first-class TS SDK, MCP. Post-conversation extraction bypasses 15% silent failure rate. |
| Self-evolution | 6-stage ladder | Each stage complete and useful alone. Data thresholds gate progression. |
| Scheduling | BullMQ | In-app, agent-modifiable. systemd: agent can't modify NixOS config. Temporal: 13GB minimum. |
| Prompt optimization | Build own (7 patterns) | Core loop ~50-100 lines TS. DSPy: Python. Ax: API churn (348 npm releases). |
| Infrastructure | NUC -> Hetzner -> Mac Mini | Prove workload at each tier. NUC has ~4GB free. |
| Model strategy | Hybrid: subscription CLI + per-token API | Background tasks via `claude -p` ($0). Interactive via API (~$80-200/mo). |
| Interface | Telegram first, adapter pattern | Messenger is transport. Telegram first (existing usage). Adapter pattern for CLI/Discord/API. |
| Personal agents | Build own | No existing tool covers memory + agent runtime + evolution together. |
| Team tool | Dust.tt or Onyx | Separate from personal bot. Dust: $315/mo, 88% DAU. Onyx: MIT, self-hosted. |

## Eliminated Options

| Tool | Category | Why eliminated |
|-|-|-|
| LangGraph | Framework | Immutable compiled graph can't self-evolve at runtime |
| LangChain | Framework | Universally negative developer sentiment, abstraction overhead |
| Pydantic AI | Framework | Lags provider features by weeks, 70+ releases in 6 months |
| Mastra | Framework | Graduation path only — revisit if plumbing > ~500 lines |
| DSPy | Prompt opt | Python-only, wrong language |
| Ax | Prompt opt | 348 npm releases (API churn), bus factor |
| Temporal | Scheduling | 13+GB RAM, enterprise infrastructure |
| Windmill | Scheduling | 3+GB baseline, visual flow builder fights raw SDK |
| Activepieces | Scheduling | 1.5GB baseline (revisit for MCP integrations) |
| Mem0 | Memory | No MCP, limited memory types |
| Graphiti | Memory | O(n) growth bug, Python-only |
| Letta | Memory | Oversized for personal use, was in AI agent sunset |
| LightRAG | Memory | Wrong scale — personal has thousands of facts, not millions of docs |
| PAI | Reference arch | 95% single-author, breaking changes every 2 weeks, 80% false-positive ratings |
| Peer mesh | Topology | 17x error amplification, 3-5x dev cost, 0 production deployments |

## Adopted Patterns

| Source | Patterns |
|-|-|
| NanoClaw | Channel registry, GroupQueue (per-entity FIFO), cursor-based crash recovery, drift-resistant scheduling, activity-based timeouts, internal tag stripping, orchestrator-holds-secrets |
| Mastra | Post-conversation Observer extraction, confidence-based network routing |
| memU | Salience scoring, route intention gate, tiered retrieval, tool performance tracking |
| DSPy MIPROv2 | Bootstrapped few-shot, instruction candidate generation with tip randomization |
| DSPy GEPA | Textual feedback in metrics, Pareto frontier, reflective mutation |
| Ax ACE | Playbook with delta edits (Generator/Reflector/Curator loop) |
| Voyager | Skill library (code + description separation, compositional skills) |
| DGM | Tree-structured archive, lineage tracing (safety lesson) |
| PAI | ISC decomposition, AI Steering Rules as DB rows, learning signal capture |
