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

**Gap:** `MemoryProvider` interface doesn't yet expose `tagsMatch` or `tag_groups` — add when implementing memory tools.

## Memory Access Control via Tags `[proposed]`

Memory access control uses the same Hindsight tag mechanism as network classification — no separate ACL system needed.

**Two orthogonal dimensions:**

| Dimension | Purpose | Examples |
|-|-|-|
| **Compartment** (lateral) | Domain isolation — different areas of life | `compartment:personal`, `compartment:work`, `compartment:health`, `compartment:financial`, `compartment:technical` |
| **Trust tier** (vertical) | Plugin trust boundary — who can access | `trust:first-party` (only profiles you control), `trust:any` (safe for third-party plugins) |

Profiles declare which compartments and trust levels they can access. The orchestrator constructs compound tag filters via Hindsight's `tag_groups` at recall time, enforced through the `Service` interface (see `agents.md` → Tool Architecture):

```
// "coder" profile recall filter:
{
  and: [
    { tags: ["compartment:work", "compartment:technical"], match: "any_strict" },
    { tags: ["trust:first-party"], match: "any_strict" }
  ]
}
```

A memory about a date tagged `compartment:personal` is invisible to the coder profile. A memory tagged `trust:first-party` is invisible to third-party plugin profiles. Same bank, same entity graph — just filtered at the capability boundary.

**Tagging strategy:**
- **Observer assigns** compartment and trust tags during post-conversation extraction (same as network classification)
- **Default:** untagged memories get `trust:first-party` (safe default — restrict rather than expose)
- **User override:** user can explicitly tag sensitive info ("this is private")

**Relationship to networks:** Networks classify *what kind of knowledge* (world/bank/opinion/observation). Compartments classify *what domain*. Trust classifies *who can access*. All three are just tags — independent, combinable, filtered by the same mechanism. A memory can be `network:world` + `compartment:work` + `trust:any` (a public work fact any plugin can see).

**For MVP:** Document the mechanism, implement the tag filtering in `Service`, but start with no compartment restrictions. Add compartment/trust tagging when profiles with different access needs exist. The infrastructure (tags + capability scoping) is ready from day 1.

## Four Memory Networks `[proposed]`

| Network | Contents | Examples |
|-|-|-|
| World | External facts | "homelab IP is 10.0.10.10", "Grafana runs on port 3000" |
| Bank | Personal facts/preferences | "prefers tables over prose", "allergic to peanuts", "wife's birthday March 15" |
| Opinion | Agent's learned assessments | "user gets frustrated with verbose explanations", "email extraction v3 works better" |
| Observation | Behavioral patterns | "usually asks about homelab on weekends", "ignores morning briefings before 8am" |

## Observer Pattern (Post-Conversation Extraction) `[confirmed]`

Adopted from Mastra's 94.87% LongMemEval approach. ~50 lines TypeScript.

```typescript
// After conversation goes idle (~5 min no messages)
async function extractMemories(transcript: Message[]): Promise<void> {
  const response = await claude.messages.create({
    model: "claude-sonnet-4-20250514",
    system: EXTRACTION_PROMPT,
    messages: [{ role: "user", content: formatTranscript(transcript) }],
    // Structured output: array of {fact, network, confidence}
  });

  const memories = parseExtraction(response);
  for (const mem of memories) {
    // Consolidation (dedup, observation creation) runs automatically
    // inside Hindsight after each retain() call — no separate step needed.
    await hindsight.retain(mem.fact, mem.network);
  }
}
```

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

### Should `reflect` be an LLM tool? `[proposed]`

`reflect()` is a real-time operation suitable as an agent tool. Use case: questions that need multi-hop reasoning across memories ("What risks should I watch for on project X?", "Summarize everything I know about Alice's career"). `recall()` returns raw facts; `reflect()` synthesizes an answer.

Cost: `reflect()` makes its own LLM calls inside Hindsight (configurable budget: low/mid/high). It's heavier than `recall()`.

Decision: start with `memory_recall` and `memory_retain` tools. Add `memory_reflect` if `recall()` proves insufficient for synthesis-heavy queries.

## Embedding Model `[research]`

Hindsight handles embedding internally — model choice is a config option.

| Tier | Model | Cost | Notes |
|-|-|-|-|
| Cloud | gemini-embedding-001 (suggested from research, not confirmed) | $0.006/MTok | #1 MTEB ranking |
| Local (Mac Mini tier) | nomic-embed-text-v2-moe (suggested from research, not confirmed) | $0 | Best open-source, Ollama-compatible |

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

## Route Intention Gate `[research]`

From memU. Before retrieval, classify: "does this query need memory?" Saves ~30% of retrieval costs. Simple LLM call or keyword heuristic.

## Tiered Retrieval `[research]`

From memU.

1. Search relevant categories/networks first
2. Check if results are sufficient (confidence threshold)
3. Drill into other networks only if needed

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
