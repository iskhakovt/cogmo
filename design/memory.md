# Memory

## Store: Hindsight `[confirmed]`

| Attribute | Detail |
|-|-|
| Client | `@vectorize-io/hindsight-client` (HTTP client, no DB access) |
| Server | `ghcr.io/vectorize-io/hindsight` (self-hosted Python service) |
| License | MIT |
| Storage | Server manages its own PostgreSQL + pgvector (can share our Postgres instance) |
| LLM | Server uses an LLM provider (Anthropic, OpenAI, etc.) for extraction and reflection |
| Benchmark | 91.4% LongMemEval |
| Key ops | `retain(bankId, content)`, `recall(bankId, query)`, `reflect(bankId, query)` |
| MCP | Native MCP server |

Hindsight is a client-server system. Our app talks to it via HTTP — no direct database access. The server handles storage, embedding, retrieval, and deduplication. We supply the extraction logic (what goes in) and retrieval queries (what comes out).

## Bank Strategy `[confirmed]`

One Hindsight bank per user, tags for memory networks. Networks are **not** separate banks.

| Strategy | Tradeoff | Verdict |
|-|-|-|
| One bank per network per user (`ti-world`, `ti-opinions`, ...) | Strongest isolation, but **no cross-bank search in Hindsight** — "what do I know about Alice?" requires 4 API calls + client merge. Entity graphs are fragmented. Consolidation LLM costs multiplied per bank. | Reject |
| **One bank per user, tags for networks** | Unified entity graph — "Alice" connects across all networks. Query one network, multiple, or all. Hindsight supports `observation_scopes: "per_tag"` for separate consolidation per network. | **Adopt** |
| One global bank, metadata for everything | All users share entity graph. Missing filter = data leakage. No benefit over per-user banks for single-user. | Reject |

Usage: `bankId = userId` (e.g. `"ti"`), retain with `tags: ["network:world"]`, recall with tags to filter or omit for full-brain search. Hindsight's `tagsMatch` modes (`any`, `all`, `any_strict`, `all_strict`) and compound `tag_groups` provide fine-grained filtering.

**Interface:** `MemoryProvider` exposes `tags` and `tagsMatch` on `RecallOptions` and `ReflectOptions`. `tag_groups` (compound boolean filters) deferred until compartment/trust ACL is implemented — simple `tags` + `tagsMatch` is sufficient for network filtering.

## Memory Access Control via Tags `[confirmed]`

Memory access control uses the same Hindsight tag mechanism as network classification — no separate ACL system needed.

**Two orthogonal dimensions:**

| Dimension | Purpose | Examples |
|-|-|-|
| **Compartment** (lateral) | Domain isolation — different areas of life | `compartment:personal`, `compartment:work`, `compartment:health`, `compartment:financial`, `compartment:technical` |
| **Trust tier** (vertical) | Plugin trust boundary — who can access | `trust:first-party` (only profiles you control), `trust:any` (safe for third-party plugins) |

Profiles declare which compartments and trust tiers they can access via the `profiles.memory_scope` JSONB column (`{ compartments: NonEmpty<string>, trust: NonEmpty<string> } | null`, validated by `ProfileMemoryScopeSchema`). The `Service` constructor folds the scope into a `tag_groups` filter applied to every recall and reflect — retain is intentionally not scoped, since writes go to Hindsight as-is and tagging happens at extraction time. The filter is AND across dimensions, OR within (`any_strict` mode, which excludes untagged memories so legacy un-compartmented rows don't leak):

```
// "coder" profile recall filter (memoryScope = {compartments: ["work","technical"], trust: ["first-party"]}):
{
  and: [
    { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
    { tags: ["trust:first-party"], match: "any_strict" }
  ]
}
```

A memory about a date tagged `compartment:personal` is invisible to the coder profile. A memory tagged `trust:first-party` is invisible to third-party plugin profiles. Same bank, same entity graph — just filtered at the capability boundary. `memoryScope = null` means "no restriction" (every memory visible) — the default for profiles that don't declare a scope.

Caller-supplied `tags` / `tagsMatch` and `tagGroups` are folded into the same AND group as additional leaves, so a profile-scoped recall composes cleanly with tool-level filters.

**Tagging strategy:**
- **Observer assigns** compartment and trust tags during post-conversation extraction (same path as network classification — see `extract-memories.ts` and `drain-pending-memories.ts`).
- **Default:** untagged memories are excluded from scoped recalls (`any_strict` semantics). Profiles with `memoryScope: null` see them.
- **Migration backfill** through `scripts/migrate-memories.ts` ensures every pre-existing memory is reclassified through the same Observer prompt.

**Relationship to networks:** Networks classify *what kind of knowledge* (world/bank/opinion/observation). Compartments classify *what domain*. Trust classifies *who can access*. All three are just tags — independent, combinable, filtered by the same mechanism. A memory can be `network:world` + `compartment:work` + `trust:any` (a public work fact any plugin can see).

**UX for declaring scope:** Set via `/profile scope <name>` from Telegram — text-spec, scriptable. `/profile scope <name>` shows; `clear` removes; `compartments=work,technical trust=first-party` sets (both keys required, comma-separated lists, order-independent). Inline-keyboard multi-select picker would be polish but text-spec is enough for personal use; revisit only if multi-user adoption stresses the scriptable form.

### Live Retains via Staging `[confirmed]`

`memory_retain` does not write directly to Hindsight. The tool inserts into a `pending_memories` table; Observer drains pending rows during post-conversation extraction, classifies each (network + compartment + trust) via `chatTyped()`, retains to Hindsight, and deletes the staging row. This guarantees a single classification path — every memory in Hindsight is tagged by the Observer prompt, and live writes cannot bypass policy.

`pending_memories` is user-scoped (FK to `users`, no `conversation_id`): pending rows survive `/reset` and are drained on any subsequent `conversation/idle` for that user. The trade-off is freshness — a live retain isn't searchable in a *different* conversation until the source conversation goes idle. Acceptable because conversations are typically idle within seconds of the last user turn, and within the source conversation the fact is already in the LLM context.

```
pending_memories (
  id            UUIDv7 PK,
  user_id       UUID NOT NULL REFERENCES users(id),
  content       TEXT NOT NULL,
  context       TEXT,                   -- nullable: optional caller-supplied context
  source        pending_memory_source NOT NULL,  -- enum: 'live_retain' | 'migration'
  created_at    TIMESTAMPTZ NOT NULL,
)
```

The `source` enum distinguishes live tool calls from one-off ingestion paths (e.g. backfilling untagged Hindsight memories through the same classifier). Both flow through the same Observer drain step; the discriminator is informational.

## Four Memory Networks `[confirmed]`

| Network | Tag | Contents | Examples |
|-|-|-|-|
| World | `network:world` | External facts | "homelab IP is 10.0.10.10", "Grafana runs on port 3000" |
| Bank | `network:bank` | Personal facts/preferences | "prefers tables over prose", "allergic to peanuts", "wife's birthday March 15" |
| Opinion | `network:opinion` | Agent's learned assessments | "user gets frustrated with verbose explanations", "email extraction v3 works better" |
| Observation | `network:observation` | Behavioral patterns | "usually asks about homelab on weekends", "ignores morning briefings before 8am" |

### Classification Strategy `[confirmed]`

Tags are assigned **at extraction time, not retain time**. No production memory system asks the agent to pick a category during conversation — classification is a post-processing concern. Observer is the sole writer to Hindsight; both extraction paths flow through the same classifier prompt.

| Path | Source | When classified |
|-|-|-|
| **Transcript extraction** | Observer reads the conversation history, extracts facts via `chatTyped()` | At `conversation/idle` |
| **Live retain via staging** | `memory_retain` tool inserts into `pending_memories`; Observer drains pending rows for the user | At `conversation/idle` |

**Why not agent-chosen tags at retain time:** Adding `network` / `compartment` / `trust` parameters to `memory_retain` forces the agent to reason about taxonomy on every retain call — extra tokens, extra failure mode, no benefit since Observer classifies with full conversation context and a single prompt. Letta, Mem0, and LangMem all treat classification as extraction-time, not retain-time. We extend that principle to compartment and trust as well.

### Retrieval Strategy `[confirmed]`

Auto-recall and `memory_recall` tool search **all networks** — no network filter. Hindsight's relevance scoring (vector + keyword + graph + temporal) handles ranking across networks. Filtering by network would require the system to predict which network contains the answer before searching, which is a harder problem than just searching everything.

**Deferred:** Network-filtered recall (e.g., "search only my opinions") as an optional parameter on `memory_recall`. Add when there's evidence of cross-network noise in recall results.

## Observer Pattern (Post-Conversation Extraction) `[confirmed]`

Adopted from Mastra's 94.87% LongMemEval approach. The Observer is an Inngest function triggered by `conversation/idle`. It has two extraction phases:

1. **Correction extraction** (Stage 1 evolution) — already implemented. Extracts behavioral corrections, persists as steering rules with graduation.
2. **Memory extraction** — extracts facts from conversation, classifies into networks, retains to Hindsight with tags.

### Memory Extraction `[confirmed]`

Added as a new step in the existing Observer function, after correction extraction. Uses `chatTyped()` with a Zod schema to extract structured facts.

```typescript
// Extraction schema (chatTyped structured output)
interface ExtractedMemory {
  fact: string;                                        // the memory content
  network: "world" | "bank" | "opinion" | "observation"; // classification
  context?: string;                                    // when/why this was learned
}

// Observer step: extract-memories (after extract-corrections)
const memories = await step.run("extract-memories", async () => {
  const extracted = await chatTyped(provider, {
    model,
    system: MEMORY_EXTRACTION_PROMPT,
    messages: [{ role: "user", content: formatTranscript(history) }],
    schema: extractedMemoriesSchema,
  });

  // Retain each fact with network tag
  for (const mem of extracted) {
    await memory.retain(userId, mem.fact, {
      tags: [`network:${mem.network}`],
      context: mem.context,
      metadata: { source: "conversation" },
    });
  }

  return { count: extracted.length };
});
```

The extraction prompt instructs the LLM to:
- Extract facts worth remembering from the conversation (skip greetings, small talk, transient discussion)
- Classify each fact into a network (world/bank/opinion/observation)
- Avoid extracting information the agent already stored via `memory_retain` during the conversation (dedup hint)
- Apply memory admission criteria: future utility, factual confidence, semantic novelty

Hindsight handles deduplication and consolidation automatically after each `retain()` call — if the same fact is extracted from multiple conversations, Hindsight merges them rather than creating duplicates.

### Observation Scoping `[confirmed]`

Retain calls use `observation_scopes: "per_tag"` so Hindsight creates separate consolidated observations per network. Without this, a world fact and a personal preference about the same entity would be merged into one observation — losing the network distinction at the observation layer.

### Why Post-Conversation, Not Real-Time `[confirmed]`

- ~15% silent failure rate when LLMs try to remember during conversation
- 62% accuracy on HaluMem benchmark for in-context memory
- 74% update omission rate
- Post-conversation extraction bypasses the "remember to remember" problem entirely

## Hindsight Operations `[confirmed]`

Three distinct operations — don't confuse them:

| Operation | What it does | When to use |
|-|-|-|
| **`retain()`** | Stores a memory. Consolidation engine runs **automatically** after each call — creates/updates observations (synthesized knowledge from multiple related facts), deduplicates. | Post-conversation extraction (Observer), real-time via `memory_retain` tool |
| **`recall()`** | Searches memories — parallel vector, keyword, graph, and temporal search, returns ranked raw results. | Real-time retrieval via `memory_recall` tool |
| **`reflect()`** | Spins up an **agentic reasoning loop** inside Hindsight — searches memories, follows entity graph links, synthesizes an answer. Returns interpretation, not raw data. | Real-time Q&A for complex questions needing synthesis across many facts |

`reflect()` is **not** consolidation. It reads from the consolidation layer but doesn't write to it. Consolidation is automatic inside `retain()`.

### Should `reflect` be an LLM tool? `[confirmed]`

`reflect()` is a real-time operation suitable as an agent tool. Use case: questions that need multi-hop reasoning across memories ("What risks should I watch for on project X?", "Summarize everything I know about Alice's career"). `recall()` returns raw facts; `reflect()` synthesizes an answer.

Cost: `reflect()` makes its own LLM calls inside Hindsight (configurable budget: low/mid/high). It's heavier than `recall()`.

Decision: **implemented** as the `memory_reflect` tool alongside `memory_recall` and `memory_retain`. The tool exposes the Hindsight `budget` knob (default `low`) plus `tags` / `tagsMatch` for scoped synthesis. Prompt guidance in `MEMORY_PROMPT_GUIDANCE` steers the agent toward `memory_recall` for simple lookups and reserves `memory_reflect` for open-ended, synthesis-heavy questions.

### Hindsight Adapter Workarounds `[confirmed]`

One upstream quirk the `HindsightMemoryProvider` adapter compensates for — verified empirically while wiring the integration test for tag_groups, important enough that bypassing the adapter (calling `HindsightClient` directly) loses memories silently.

**Default `types` filter excludes `observation`**. Hindsight's `recall` endpoint defaults to `types: ["world", "experience"]`. The extraction LLM produces `observation`-type facts routinely — enough that the default filter hides a meaningful slice of stored content. The adapter overrides the default in `buildRecallBody` to `["world", "experience", "observation"]` so callers see every extracted fact unless they explicitly narrow. This is independent of our `network:*` tag taxonomy: Hindsight's `fact_type` is a server-side classification, our `network:*` is a client-side tag, both are stored, both are queryable. No upstream issue filed (the default is a deliberate Hindsight design choice).

## Hindsight Provider Configuration `[proposed]`

Hindsight uses three external capabilities: LLM (fact extraction), embeddings (vector search), and reranking (result quality). Each is independently configurable.

### Docker Images

| Image | Size | Local ML | Use case |
|-|-|-|-|
| `hindsight:latest` | ~9 GB | PyTorch + bge-small + ms-marco reranker | Production (if running local models) |
| `hindsight:latest-slim` | ~500 MB | None | Tests, or when using external providers for everything |

Slim image requires external embeddings and reranker — no PyTorch, no model downloads, ~5s startup.

### LLM (Fact Extraction)

Used by `retain()` for structured fact extraction. Needs structured output / JSON mode.

| Provider | Model | Input $/M | Output $/M | Notes |
|-|-|-|-|-|
| OpenRouter | gpt-5-nano | $0.05 | $0.40 | Best quality-to-cost. Hindsight `provider=openai` with OpenRouter base URL |
| OpenRouter | gpt-oss-20b | $0.03 | $0.11 | Cheapest. Adequate for extraction |
| Google | gemini-2.5-flash-lite | $0.10 | $0.40 | 1000 req/day free tier |
| Anthropic | claude-haiku-4.5 | $1.00 | $5.00 | Hindsight default for `provider=anthropic`. Tested. |
| Local (Ollama) | qwen2.5:3b | Free | Free | Slow (60-90s per extraction). Needs full image. |

**Chosen:** gpt-4o-mini via OpenRouter for production (target was gpt-5-nano — see "Known Gaps"). Test fixtures recorded via aimock (`@copilotkit/aimock`).

### Embeddings

Used by `recall()` for semantic search. API is standardized (`POST /v1/embeddings`). Hindsight auto-detects dimensions — probes the API at startup for unknown models, hardcoded lookup for known OpenAI/Cohere models.

**Dimension lock-in:** Once memories are stored, changing to a model with different dimensions requires wiping the memory DB.

| Provider | Model | MTEB | $/M tokens | Dims | Context | Free tier |
|-|-|-|-|-|-|-|
| OpenRouter | qwen3-embedding-8b | 75.2 (English v2) | $0.01 | 1024 | 32K | None |
| Voyage AI | voyage-4 | 68.6 (vendor RTEB) | $0.06 | 1024 | 32K | 200M tokens |
| Voyage AI | voyage-4-lite | ~65 | $0.02 | 1024 | 32K | 200M tokens |
| OpenAI | text-embedding-3-small | ~62 | $0.02 | 1536 | 8K | None |
| Local (Hindsight default) | BAAI/bge-small-en-v1.5 | ~62 | Free | 384 | 512 | Needs full image |

**Chosen:** qwen3-embedding-8b via OpenRouter — best quality, cheapest. Benchmarks not directly comparable across MTEB tracks, but English v2 score of 75.2 is strong. Note: not in Hindsight's tested model list, but embedding API is standardized — confirmed to auto-detect dimensions via probe call.

**For tests:** `text-embedding-3-small` model name → Hindsight skips probe (hardcoded 1536 dims) → llmock returns deterministic vectors. No real API needed.

### Reranking

Used by `recall()` to reorder retrieved results. Quality affects recall precision.

| Provider | Model | Agentset ELO | Cost | Hindsight provider | Notes |
|-|-|-|-|-|-|
| ZeroEntropy | zerank-2 | 1638 (highest) | $0.025/M tokens | `zeroentropy` (native) | Seed-stage startup, alpha SDK |
| Voyage AI | rerank-2.5 | 1544 | $0.05/M tokens | `litellm-sdk` | MongoDB-backed, 200M free tokens |
| Voyage AI | rerank-2.5-lite | 1520 | $0.02/M tokens | `litellm-sdk` | Same free pool as rerank-2.5 |
| Cohere | rerank-3.5 | 1451 | $2.00/1K searches | `cohere` (native) | Expensive at scale |
| Local (Hindsight default) | ms-marco-MiniLM-L-6-v2 | ~1327 | Free | `local` | Needs full image (PyTorch) |
| RRF | Math only | ~3-4% below cross-encoders | Free | `rrf` | No model, no API, no dependencies |

**Chosen:** zerank-2 for production — highest quality, native Hindsight provider. RRF for tests — zero dependencies, sufficient for "did recall find the fact" assertions.

### Production Config

```bash
# LLM — gpt-4o-mini via OpenRouter (gpt-5-nano blocked, see "Known Gaps")
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=https://openrouter.ai/api/v1
HINDSIGHT_API_LLM_API_KEY=$OPENROUTER_API_KEY
HINDSIGHT_API_LLM_MODEL=openai/gpt-4o-mini

# Embeddings — qwen3-embedding-8b via OpenRouter
HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=https://openrouter.ai/api/v1
HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=$OPENROUTER_API_KEY
HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=qwen/qwen3-embedding-8b

# Reranker — zerank-2
HINDSIGHT_API_RERANKER_PROVIDER=zeroentropy
HINDSIGHT_API_RERANKER_ZEROENTROPY_API_KEY=$ZEROENTROPY_API_KEY
```

### Test Config (slim image + llmock)

```bash
# LLM — llmock replays recorded fixtures
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:$LLMOCK_PORT/v1
HINDSIGHT_API_LLM_API_KEY=test-key
HINDSIGHT_API_LLM_MODEL=gpt-4o-mini  # NOT gpt-5-nano — see "Known Gaps" below

# Embeddings — llmock deterministic vectors (no real API)
HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=http://host.docker.internal:$LLMOCK_PORT/v1
HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=test-key
HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=text-embedding-3-small

# Reranker — RRF (math only, no model)
HINDSIGHT_API_RERANKER_PROVIDER=rrf

# Skip startup verification call
HINDSIGHT_API_SKIP_LLM_VERIFICATION=true
```

### Known Gaps

**Production-vs-test model divergence (gpt-5-nano vs gpt-4o-mini).** Production targets `gpt-5-nano` for cost ($0.05/$0.40 per 1M tokens). Tests use `gpt-4o-mini` ($0.15/$0.60). Both are functionally equivalent for fact extraction.

The reason: OpenAI deprecated `max_tokens` for the entire GPT-5 series — `max_completion_tokens` is now required. Hindsight v0.5.0 explicitly uses `max_tokens` for Mistral compatibility ([vectorize-io/hindsight#858](https://github.com/vectorize-io/hindsight/pull/858)), so any GPT-5 call returns `400 Unsupported parameter`. This affects the entire ecosystem ([vercel/ai#7863](https://github.com/vercel/ai/issues/7863), [BerriAI/litellm#13381](https://github.com/BerriAI/litellm/issues/13381), [stanfordnlp/dspy#8612](https://github.com/stanfordnlp/dspy/issues/8612)).

**Implications:**
- **Production must also use `gpt-4o-mini`** until Hindsight emits `max_completion_tokens` for GPT-5 models. Production cost rises from ~$2/mo to ~$6/mo for the LLM line item — total memory cost ~$10/mo instead of $6/mo.
- **Recorded test fixtures use `gpt-4o-mini` request shape.** When Hindsight fixes this, we re-record fixtures and switch both prod + test back to `gpt-5-nano`.
- **No way to use `gpt-5-nano` today** without forking Hindsight or running a translation proxy. Not worth the complexity for a temporary issue.

Tracked in `todo.md`. Re-evaluate when Hindsight ships GPT-5 support.

### Estimated Monthly Cost (Production, 500 queries/day)

| Component | Provider | Monthly |
|-|-|-|
| LLM (extraction) | OpenRouter gpt-4o-mini | ~$6 |
| Embeddings | OpenRouter qwen3-embedding-8b | ~$0.15 |
| Reranker | ZeroEntropy zerank-2 | ~$4 |
| **Total** | | **~$10** |

Cost will drop to ~$6/mo when Hindsight ships GPT-5 support — see "Known Gaps".

## Retrieval Strategy `[proposed]`

Start simple, add complexity only when needed:

1. **Keyword search** (tsvector) — handles exact name/term matches
2. **Vector search** (pgvector) — add when FTS misses conceptual/semantic matches
3. **No graph DB** — overkill for personal-scale thousands of facts
4. **No RAG** — not needed at personal scale. Revisit if a document corpus (PDFs, notes) grows large enough to need chunking

**Graduation:** pgvector handles up to ~10M vectors. Past that, evaluate Qdrant (pgvectorscale gets 471 QPS / 99% recall on 50M vectors, but dedicated vector DBs earn their keep at that scale).

## Salience Scoring `[research]`

From memU. Rank retrieved memories by combined score:

```
score = similarity * log(mention_count + 1) * exp(-0.693 * days_since_mentioned / half_life_days)
```

Add `mention_count` and `last_mentioned_at` metadata to Hindsight memories.

## Auto-Recall and Intention Gate `[confirmed]`

Auto-recall searches Hindsight for memories relevant to the user's message and injects them into the system prompt as `# Recalled Context`. This runs before the agent loop — the agent sees recalled memories as context, not as tool output.

### Profile Setting `[confirmed]`

Auto-recall behavior is controlled by a profile-level setting:

```sql
ALTER TABLE profiles ADD COLUMN auto_recall TEXT NOT NULL DEFAULT 'heuristic';
-- CHECK (auto_recall IN ('off', 'always', 'heuristic', 'llm'))
```

| Mode | Behavior | Use case |
|-|-|-|
| `off` | No auto-recall. Agent uses `memory_recall` tool explicitly. | Profiles where memory is irrelevant (utility bots, code-only). |
| `always` | Recall on every message. Current behavior. | Maximum recall coverage, no risk of missing context. |
| `heuristic` | Skip recall for messages that obviously don't need memory. **Default.** | Daily driver — low latency, catches 20-30% of messages as skippable. |
| `llm` | LLM classifier decides whether to recall. | Higher accuracy gating (~50-60% skip rate), but adds ~200-500ms latency. |

**Default is `heuristic`**, not `always`. The heuristic is conservative — it only skips obvious acks/greetings, so false negatives (skipping when recall would have helped) are rare. The cost of a false positive (unnecessary recall) is ~$0.01 + ~300ms — harmless. The cost of a false negative (missing context) is user-visible — harmful.

### Heuristic Gate `[confirmed]`

A pure function that returns `true` when the message is unlikely to benefit from memory recall. Rules checked in order:

1. **Empty or too short** — message is whitespace-only or under 4 characters (emoji reactions, "ok", "k")
2. **Greeting/ack pattern** — case-insensitive match against a set: "hi", "hello", "hey", "thanks", "thank you", "bye", "goodbye", "got it", "sure", "okay", "yes", "no", "yep", "nope", "np", "ty", "thx"
3. **Continuation signal** — entire message (trimmed) is one of: "go ahead", "do it", "continue", "proceed", "sounds good", "lgtm", "perfect", "exactly", "agreed", "correct"

This intentionally does **not** filter by message length — short messages like "what's my API key?" or "Alice's birthday?" are exactly the queries that need recall. The heuristic only catches messages with zero informational content.

The function is stateless — no context from previous messages. It's a fast pre-filter, not a semantic classifier.

### LLM Gate `[proposed]`

A cheap LLM call (Haiku-class, ~100 tokens) that classifies: "does this message need information from long-term memory to answer well?"

```typescript
// Schema for the LLM gate response
interface GateResult {
  needs_recall: boolean;
  reason?: string; // for debugging/logging
}
```

**Why it exists alongside heuristic:** The heuristic catches syntactic patterns. The LLM understands intent — it knows "what's 2+2?" doesn't need memory but "what's that thing I mentioned yesterday?" does, even though both are short questions. At ~50 queries/day the cost difference is negligible ($0.25/day saved), but at higher volume the LLM gate's 50-60% skip rate vs heuristic's 20-30% matters.

**Implementation:** Stub the `"llm"` path initially (log a warning, fall through to `always`). Implement when there's a concrete profile that benefits from it.

### Error Handling `[confirmed]`

If the gate function throws (LLM call fails, regex error), **fall through to always-recall**. Memory recall is the safe default — skipping it is the optimization, not the other way around.

## Tiered Retrieval `[research]`

From memU.

1. Search relevant categories/networks first
2. Check if results are sufficient (confidence threshold)
3. Drill into other networks only if needed

Deferred — current approach searches all networks in a single `recall()` call. Tiered retrieval adds complexity (multiple API calls, confidence thresholds) for marginal quality improvement at personal scale. Revisit if recall results become noisy as memory grows past ~10K facts.

## Memory Admission Control `[research]`

Five factors (from A-MAC, arXiv 2603.04549):
- Future utility
- Factual confidence
- Semantic novelty (don't store what's already known)
- Temporal recency
- Content type prior

Apply as a lightweight filter in the extraction prompt, not a separate system.

## Metadata Schema `[proposed]`

Each memory should carry:

```typescript
interface MemoryMetadata {
  agent_id: string;        // which agent wrote this
  source: string;          // "conversation" | "ingestion:email" | "ingestion:calendar" | ...
  confidence: number;      // 0-1, from extraction
  mention_count: number;   // incremented on re-extraction
  last_mentioned_at: Date; // for salience scoring
  created_at: Date;
}
```
