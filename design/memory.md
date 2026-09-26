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

## Core Memory vs Hindsight `[confirmed]`

Two stores hold what the agent knows about its user. **Core memory** is a few keyed blocks (`core_memory_blocks`, one row per user and key) rendered into every system prompt's `# User` section, so it survives compaction and needs no retrieval. Only the agent writes it, through `core_memory_update`. **Hindsight** holds everything else and is searched on demand by auto-recall, `memory_recall` and `memory_reflect`. The Observer fills it from every conversation at idle, whether or not the agent called `memory_retain`.

**Rule.** Core memory holds what every conversation needs. Everything that can be looked up when the topic comes up goes to Hindsight.

| Core memory | Hindsight |
|-|-|
| Who the user is: name and what to call them, role and employer, home and timezone, who their close family are | Events: a dinner out, a conference trip, a bug fixed |
| Active projects and their status | Details: a sister's birthday, the rent, a book finished |
| Standing preferences and constraints: spelling variety, diet, working days | One-off decisions about a single task: a bar chart for the quarterly report |
| | Facts about other people: a friend's new job, a partner's promotion |

The test is whether a reply to an unrelated message could go wrong without the fact. A family member belongs in core memory, and details about them belong in Hindsight. A trip leaves home and timezone as they are, and a one-off request ("this one as a list") is not a standing preference. A change replaces the old value (Lisbon replaces London) and a finished project leaves the block; the history is Hindsight's.

**When.** In the turn the fact appears, including when it comes up in passing while the user asks for something else ("we only moved here last month"). `core_memory_update` overwrites the block, so the call rewrites it whole. The Observer writes only Hindsight, so a core fact the agent doesn't write in the turn never reaches a later prompt. Core memory therefore depends on the agent remembering to write in-turn, which is the failure mode the Observer avoids for Hindsight (see [Why Post-Conversation, Not Real-Time](#why-post-conversation-not-real-time-confirmed)). The evaluation below measures how often the agent writes it.

**Where it lives.** `CORE_MEMORY_PROMPT_GUIDANCE` and `MEMORY_PROMPT_GUIDANCE` (`src/agent/service.ts`) state the rule in every prompt's `# Capabilities` section. The `core_memory_update` and `memory_retain` descriptions repeat it at the point of choice, and the onboarding text (`src/agent/prompt.ts`), shown while no block exists, sends what the agent learns about the user, including what they mention in passing, to core memory.

**Prior art.** MemGPT's working context is "a fixed-size read/write block of unstructured text … intended to be used to store key facts, preferences, and other important information about the user", with everything else in archival storage searched through function calls ([Packer et al., 2023](https://arxiv.org/abs/2310.08560)). Letta keeps the split: memory blocks are pinned to the context window ([memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)), and archival memory is not for "information that should always be visible" or "frequently changing state" ([archival memory](https://docs.letta.com/guides/core-concepts/memory/archival-memory)). LangMem draws the same line between a *profile*, "a single document that represents the current state" updated in place, and a *collection* of searchable records ([conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)).

### Evaluation

`src/agent/core-memory-routing.live.test.ts` runs 29 labelled single-turn messages (`test/fixtures/evals/core-memory-routing.json`) through the production prompt, the built-in tool definitions and the agent loop on the seeded profile's model. Tool handlers are stubs, so nothing is persisted. It records which memory tools each turn calls. The 29 are 12 core facts (9 announced, 3 mentioned in passing while asking for something else), 9 Hindsight facts and 8 messages worth storing nowhere, including boundary cases: a conference trip, a partner's promotion, a one-off format request and a finished project. Each runs twice: with no core memory, where the prompt shows the onboarding text, and with established blocks, in key order as production renders them. The finished project runs only with established blocks. The eval also checks that each write targets one of the case's expected blocks and, with established blocks, which established lines a rewrite lost and that a finished project is gone. Each established line names its anchors, the words that carry its fact, and a rewrite keeps the line while it still names them all. The eval reports rather than asserts (see [testing.md](testing.md) → Live Tests).

Results on `claude-sonnet-5`, one sample per case. *Baseline* is the guidance before this rule: the core-memory guidance said only "Update them as you learn new things", and onboarding said "Store what you learn using memory_retain". It predates the boundary cases and the content checks (—). *Rule* is the current guidance.

| Metric | Baseline, empty | Baseline, established | Rule, empty | Rule, established |
|-|-|-|-|-|
| Core facts written to core memory in the turn | 3/11 | 8/11 | 10/11 | 12/12 |
| — announced | 3/8 | 7/8 | 7/8 | 9/9 |
| — in passing | 0/3 | 1/3 | 3/3 | 3/3 |
| — in the first response | 0/11 | 5/11 | 2/11 | 12/12 |
| — to an expected block | — | — | 10/10 | 12/12 |
| — finished project dropped | — | — | — | 0/1 |
| Rewrites that lost an established line the case doesn't change | — | — | — | 0/12 |
| Core facts sent to `memory_retain` only | 2/11 | 2/11 | 0/11 | 0/12 |
| Core writes on Hindsight facts | 0/7 | 0/7 | 0/9 | 0/9 |
| Core writes on messages worth storing nowhere | 0/7 | 0/7 | 0/8 | 0/8 |

On the baseline, the agent updated core memory for announced facts once blocks existed but mostly missed facts mentioned in passing. With no blocks, onboarding drew the turn into introductions, and core facts went to `memory_retain` or nowhere. Under the rule, every core fact reaches an expected block once blocks exist, all in the first response, and no rewrite loses an established line beyond those the case declares it changes or drops. With no blocks, 10 of 11 core facts reach core memory, including every fact mentioned in passing. No Hindsight fact or other message writes core memory, the conference trip and the partner's promotion included. The finished project is a known miss against the rule: the rewrite marks it completed in `active_projects` instead of removing it.

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
| **Compartment** (lateral) | Domain isolation — different areas of life | `compartment:personal`, `compartment:work`, `compartment:health`, `compartment:financial`, `compartment:technical`, `compartment:misc`, plus per-user customs (e.g. `compartment:dnd`) |
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
- **Migration backfill** through `cogmo migrate-memories <bankId>` ensures every pre-existing memory is reclassified through the same Observer prompt. A complementary `cogmo backfill profile-class --tag=<a,b>` stamps `profile_class:*` tags onto existing memories without re-classifying anything else — used to opt an existing deployment into class-scoped recall without classifier drift on already-correct compartment / trust labels.

**Relationship to networks:** Networks classify *what kind of knowledge* (world/bank/opinion/observation). Compartments classify *what domain*. Trust classifies *who can access*. All three are just tags — independent, combinable, filtered by the same mechanism. A memory can be `network:world` + `compartment:work` + `trust:any` (a public work fact any plugin can see).

**UX for declaring scope:** Set via `/profile scope <name>` from Telegram — text-spec, scriptable. `/profile scope <name>` shows; `clear` removes; `compartments=work,technical trust=first-party` sets (both keys required, comma-separated lists, order-independent). Inline-keyboard multi-select picker would be polish but text-spec is enough for personal use; revisit only if multi-user adoption stresses the scriptable form.

**Custom compartments (hybrid registry) `[confirmed]`:** The six core values (`personal/work/health/financial/technical/misc`) are an in-code Zod enum (`CORE_COMPARTMENTS`), always classifiable. Per-user extensions live in the `custom_compartments` table (`(user_id, name, description)`, unique on `(user_id, name)`, capped at 10). The Observer loads these on each fire and templates `description` into the classifier prompt via `buildCompartmentDefinitions`, then locks the structured-output `compartment` field to `[...CORE, ...customs]` via `buildExtractedMemorySchema(customs)` / `buildClassifiedMemorySchema(customs)` — descriptions are LLM-facing instructions, not documentation. The classifier is told to prefer custom buckets over core when a fact fits both, so adding `compartment:dnd` actually pulls campaign facts out of `personal`. Profile scope validation is runtime: an unknown value on `/profile scope` surfaces as `compartment_unknown` from Transport (parser can't see customs without DB I/O); reserved-name guard rejects core values at create time. Forward-only delete: `/compartments rm dnd` drops the option from future classifications but leaves existing `compartment:dnd` Hindsight tags intact (Cogmo doesn't store memory rows itself, so an FK-style RESTRICT isn't possible). UX is `/compartments [list|add <name> <description>|rm <name>]`, mirroring `/classes`. Cap is from Zep's playbook: >10 buckets degrades classifier accuracy and bloats the prompt linearly.

**Restricted profile classes (fail-closed recall) `[confirmed]`:** A `profile_classes.restricted` boolean flips recall to fail-closed for the marked class — memories tagged `profile_class:<r>` are invisible to any profile that doesn't either (a) explicitly opt the class into `memory_scope.profileClasses` or (b) speak as the class itself (`profile.profile_class = <r>`). Default `false` preserves the open-by-default behaviour for unmarked classes. The Service builds a NOT leaf alongside the existing scope leaves: `{ not: { tags: ["profile_class:r1", "profile_class:r2", …], match: "any" } }` over the set of restricted classes the profile hasn't opted into. The leaf uses `match: "any"` (not `any_strict`) — only memories carrying one of those tags are excluded; untagged legacy rows pass through unchanged. Marking a class restricted has no retroactive effect on already-tagged memories — same forward-only semantics as `/compartments rm`. Telegram surface: `/classes restrict <name>` / `/classes unrestrict <name>`; `/classes list`, `/profile list`, `/profile scope` annotate restricted classes with a marker (`(restricted)` in `/classes`, `!` in `formatScope`, `[class=…!]` in `/profile list`). `/classes rm` is independent of `restricted` — the FK-RESTRICT contract still gates deletion of in-use classes regardless of the flag.

**Speaker auto-include in the recall filter `[confirmed]`:** A profile *always* sees its own writes, regardless of how the operator configured `memory_scope.profileClasses`. The class leaf the Service emits is structurally `scope.profileClasses ∪ {profile.profile_class}`, not just `scope.profileClasses`. This applies symmetrically to both the `any_strict` opt-in leaf (when scope is set) and the `NOT` restricted-exclusion leaf (when restricted classes exist). Matches the convention in every personal-data system surveyed — email's Sent folder, Drive owner-implicit-read, PostgreSQL RLS's `USING (owner = current_user)` idiom: self-recall is a primitive of the actor, not a configuration parameter. Concrete consequence: a profile with `profileClass = "intimate"` and `memory_scope.profileClasses = ["general"]` sees both intimate and general writes on recall — the today-footgun where the profile silently lost access to its own writes is gone. For the rare auditor / write-only-channel pattern (write to one class, *deliberately* don't recall those writes), the right primitive is `profile.profileClass = null` (write untagged) plus `memory_scope.profileClasses = […]` for what to read — don't conflate "what tag to stamp on writes" with "speaker identity in the recall filter." `formatScope` renders the auto-include explicitly: `classes: general, intimate (speaker)` so the operator's view matches the effective filter, not just the stored config.

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

Three upstream behaviours the `HindsightMemoryProvider` adapter compensates for. Bypassing the adapter (calling `HindsightClient` directly) gets each of them wrong: the first two surface as errors where the adapter returns an empty or truncated recall, and the third hides memories silently. The first two are pinned by integration tests against the real server in `src/test/memory.integration.test.ts`.

**Recall on a bank that was never created is a 404.** Hindsight creates a bank on its first write; reads refuse a bank that does not exist rather than answer as if it were empty. With `bankId = userId`, that is every user who has not had a memory retained yet — a new user's first conversation, before the Observer drains anything. The adapter maps the 404 to no memories, so auto-recall, `memory_recall` and skills see an empty bank rather than an error. It matches Hindsight's exact detail, `Bank '<id>' not found`, so any other 404 (a wrong base path, a proxy prefix, a gateway echoing the request path, which carries the bank id) still fails loudly instead of reading as a forgetful agent. Operator CLIs that list a bank (`cogmo migrate-memories`, `cogmo backfill profile-class`) keep the 404: an explicitly named bank that does not exist is worth being told about. Reflect is unaffected — it creates the bank.

**Query cap counted in `o200k_base`.** Hindsight caps a recall query at `HINDSIGHT_API_RECALL_MAX_QUERY_TOKENS` (default 500) counted in `HINDSIGHT_API_TOKENIZER_ENCODING` (default `o200k_base`), and rejects an over-cap query with a 400 rather than truncating it. The adapter truncates to the cap in the same vocabulary before sending. The two must agree. Other encodings differ from `o200k_base` by a few tokens either way on ordinary prose and code: roughly a third of 500-token `cl100k_base` cuts measure over 500 in `o200k_base`. The resulting 400 degrades auto-recall to nothing for exactly the long messages that carry the most context. Special-token text such as `<|endoftext|>` counts as ordinary text on both sides.

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

A cross-encoder pass over the candidates RRF fusion produces — **not an alternative to RRF**. Hindsight always fuses its four retrieval arms (semantic, BM25, graph, temporal) with reciprocal rank fusion, caps the result at `HINDSIGHT_API_RERANKER_MAX_CANDIDATES` (default 300), then reranks what survives. `HINDSIGHT_API_RERANKER_PROVIDER=rrf` therefore means "skip the cross-encoder and keep the fusion order", the same thing `HINDSIGHT_API_ENABLE_RERANKING=false` does. Reranking sets which memories reach the context window, so its quality decides what the agent knows, not merely what order it reads.

| Provider | Model | Agentset ELO | Cost | Hindsight provider | Notes |
|-|-|-|-|-|-|
| OpenRouter | `voyageai/rerank-2.5` | 1544 | $0.05/M tokens | `openrouter` (native) | Reuses the OpenRouter key already set for LLM + embeddings |
| OpenRouter | `voyageai/rerank-2.5-lite` | 1520 | $0.02/M tokens | `openrouter` (native) | Same gateway, 40% of the cost |
| OpenRouter | `cohere/rerank-v3.5` | 1451 | $0.001/search | `openrouter` (native) | Hindsight's default model for this provider |
| OpenRouter | `cohere/rerank-4-pro` | not rated | $0.0025/search | `openrouter` (native) | Postdates the Agentset table |
| Cohere | rerank-3.5 | 1451 | $2.00/1K searches | `cohere` (native) | Direct key; no cheaper than the same model via OpenRouter |
| Local (Hindsight default) | ms-marco-MiniLM-L-6-v2 | ~1327 | Free | `local` | Needs full image (PyTorch) |
| None — keep fusion order | n/a | ~3-4% below cross-encoders | Free | `rrf` | No model, no API, no dependencies |

ZeroEntropy's zerank-2 led this table at ELO 1638 and was the original choice. ZeroEntropy was acquired by Notion and sunset all hosted products on 2026-09-04; the weights are Apache-2.0 on HuggingFace but only as H100-class self-hosting, which personal scale does not justify. No gateway resells them.

**Chosen:** `voyageai/rerank-2.5` through Hindsight's native `openrouter` provider, with `rrf` as a failover member so an unreachable reranker degrades to fusion order instead of taking recall down. Hindsight is *not* fail-open by default — "a reranker that is unreachable takes recall down with it" — and `recall` sits on the interactive path, so the chain is load-bearing rather than belt-and-braces. Keep the primary's timeout short: auto-recall runs ahead of a turn's first model call, and members are tried in order with no circuit breaker, so a dead primary adds its full cost to every recalling turn before the fallback runs. Nothing on Cogmo's side cuts that short — `HindsightMemoryProvider`'s retry window stops new attempts after 5s but does not abort one in flight.

RRF alone for tests — zero dependencies, deterministic, sufficient for "did recall find the fact" assertions.

**Retries multiply that cost, so production turns them off.** Hindsight retries a remote reranker before advancing the chain: `HINDSIGHT_API_RERANKER_MAX_RETRIES` (default 3) with 0.5s→4s backoff, bounded by `HINDSIGHT_API_RERANKER_RETRY_BUDGET` (default 10s, spent on failed attempts and backoff, not on successful work). A timeout counts as transient, so on those defaults a primary that times out at 2s costs about 11s per recall before `rrf` answers, against 2s for a single attempt. `HINDSIGHT_API_RERANKER_MAX_RETRIES=0` keeps it at one timeout. With a fallback member behind the primary, a transient 429 or 5xx then costs one recall its cross-encoder ordering, which is cheaper than stalling the turn. The setting is global, but `rrf` carries no retry policy, so in this chain it only reaches the primary.

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

# Reranker — voyageai/rerank-2.5 via OpenRouter, falling back to fusion order.
# The API key falls back to HINDSIGHT_API_LLM_API_KEY, so no extra credential.
HINDSIGHT_API_RERANKER_PROVIDER=openrouter
HINDSIGHT_API_RERANKER_OPENROUTER_MODEL=voyageai/rerank-2.5
HINDSIGHT_API_RERANKER_OPENROUTER_TIMEOUT=2
# One attempt, then fail over — see "Retries multiply that cost" above.
HINDSIGHT_API_RERANKER_MAX_RETRIES=0

# Failover member 1 — indexed members inherit nothing, so spell out every
# setting they need with their own index.
HINDSIGHT_API_RERANKER_1_PROVIDER=rrf
```

### Test Config (slim image + llmock)

```bash
# LLM — llmock replays recorded fixtures
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=http://host.testcontainers.internal:$LLMOCK_PORT/v1
HINDSIGHT_API_LLM_API_KEY=test-key
HINDSIGHT_API_LLM_MODEL=gpt-4o-mini  # NOT gpt-5-nano — see "Known Gaps" below

# Embeddings — llmock deterministic vectors (no real API)
HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai
HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=http://host.testcontainers.internal:$LLMOCK_PORT/v1
HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=test-key
HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=text-embedding-3-small
# One text per request — Hindsight coalesces a retain's concurrent embedding
# calls by timing, and llmock's key for a shared request depends on the grouping
HINDSIGHT_API_EMBEDDINGS_OPENAI_BATCH_SIZE=1

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
| Reranker | OpenRouter voyageai/rerank-2.5 | ~$8 |
| **Total** | | **~$14** |

Cost will drop to ~$10/mo when Hindsight ships GPT-5 support — see "Known Gaps". Switching the reranker to `voyageai/rerank-2.5-lite` puts that line at ~$3.20/mo — $4.80 less, and below the ~$4 zerank-2 was budgeted at — for 24 points of Agentset ELO.

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

`[proposed]` Recalled memories move out of the system prompt into the turn's user message and are stored with the turn, so recall no longer changes the system prompt between turns. A memory already shown in a turn context that survives this turn's compaction isn't repeated; content that appears elsewhere in the transcript doesn't count — see [prompt-caching.md](prompt-caching.md) → Turn Context, Deduplication.

A failed recall degrades to no memories: the turn runs with no `# Recalled Context` block rather than failing into Inngest retries, and `cogmo.memory.recall.failures` counts it against the bank. The failure also logs a warning and puts the `memory.recall` span into ERROR, but the counter is the only signal an alert can watch — see [DEPLOYMENT.md → Hindsight reranker](../DEPLOYMENT.md#hindsight-reranker) for the failover chain that keeps a dead reranker from causing one.

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
