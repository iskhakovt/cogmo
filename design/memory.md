# Memory

## Store: Hindsight `[confirmed]`

| Attribute | Detail |
|-|-|
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
    await hindsight.retain(mem.fact, mem.network);
  }
}

// Periodic dedup/consolidation
async function consolidate(): Promise<void> {
  await hindsight.reflect(); // merges duplicates, consolidates related
}
```

### Why Post-Conversation, Not Real-Time `[confirmed]`

- ~15% silent failure rate when LLMs try to remember during conversation
- 62% accuracy on HaluMem benchmark for in-context memory
- 74% update omission rate
- Post-conversation extraction bypasses the "remember to remember" problem entirely

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
