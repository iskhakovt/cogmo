# Self-Evolution

First-class feature from day one. Six stages, each a complete working system. Stages unlock with data thresholds, not calendar dates.

## 6-Stage Ladder

### Stage 1: Instruction Evolution `[confirmed]`
**Trigger:** Day 1
**What:** Post-conversation correction extraction → steering rules with graduation model.
**Implementation:** Observer Inngest function (`src/agent/evolution/observer.ts`) triggered by `conversation/idle`. Loads transcript, calls `chatTyped()` to extract corrections, persists to `steeringRules` table. Transcript formatted as readable text (tool calls as `[Tool: name(input)] → result`). Global scope (`profileId: null`) — industry standard for personal assistants.
**Graduation:** `observationCount >= 2` promotes from learning (`active: false`) to rule (`active: true`). Active rules auto-injected into system prompt via `getActiveRules()`.
**Consolidation:** When active rule count exceeds 30, LLM merges semantically similar rules via `consolidateRules()`. Observation counts summed on merge.
**Safety:** Contradictions logged but not applied. Safety-category rules excluded from extraction (manual only). New corrections start at priority 100 (below manual rules).
**Scope dimensions `[confirmed]`:** Rules are scoped on two independent axes — `profile_id` and `channel_type` — both nullable, where null means "applies everywhere on that axis." Channel scope is assigned at extraction time: the Observer queries the conversation's active channels, passes the set into the extraction prompt, and the LLM tags each `new` correction with `channelType: "telegram"` (or similar) for medium-specific rules and `null` otherwise. See [agents.md](agents.md) → Observation Lineage for the full data model + extraction shape, and [transport/adapters.md](transport/adapters.md) → Response Rendering for how channels render output.
**Prerequisite:** Full tool invocation history in `messages` table (landed PR #34) — correction extraction inspects `tool_use` blocks, not just text.

### Stage 2: Skill Library `[research]`
**Trigger:** When agent repeatedly does the same multi-step task
**What:** Agent writes reusable code tools. Human reviews before promotion.
**Implementation:** Voyager pattern — `skills/code/` + `skills/description/`. Description embedding is retrieval key. Skills are compositional (new skills build on old ones).
**Review gate:** Inngest `waitForEvent()` pauses until human approves via Telegram callback.
**Standard:** SKILL.md progressive disclosure:
- Tier 1: Name + description (~50 tokens, always loaded)
- Tier 2: Full instructions (~500 tokens, on trigger)
- Tier 3: Scripts/assets (on demand)

Phase transition at ~50-100 skills — need hierarchical organization.

### Stage 3: Typed Calls + Retry `[proposed]`
**Trigger:** Day 1 (baked into architecture)
**What:** Typed LLM call contracts with feedback injection on failure.
**Implementation:**

```typescript
interface LLMCall<I, O> {
  name: string;
  input: z.ZodSchema<I>;
  output: z.ZodSchema<O>;
  prompt: string;
  maxRetries: number;
}

async function call<I, O>(spec: LLMCall<I, O>, input: I): Promise<O> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt <= spec.maxRetries; attempt++) {
    const messages = buildMessages(spec, input, lastError);
    const response = await claude.messages.create({ ... });
    const parsed = spec.output.safeParse(extractJSON(response));
    if (parsed.success) return parsed.data;
    lastError = `Attempt ${attempt + 1} failed: ${parsed.error.message}. Output was: ${JSON.stringify(response.content)}`;
  }
  throw new Error(`${spec.name} failed after ${spec.maxRetries + 1} attempts`);
}
```

On failure, feed failed output + why it failed back to model (~20 lines, from DSPy Assert/Refine).

### Stage 4: Prompt Optimization `[research]`
**Trigger:** ~50 labeled examples exist, evaluation pipeline proven
**What:** Automated search over prompt variants.
**Implementation:** Build own (~50-100 lines TS), adopting 7 patterns:

| Pattern | Source | Lines | Priority |
|-|-|-|-|
| Retry with feedback injection | DSPy Assert | ~20 | Day 1 (Stage 3) |
| Typed LLM calls | DSPy signatures | ~50 | Day 1 (Stage 3) |
| LLM-as-judge rubrics | DSPy eval | ~30 | Per-task |
| Bootstrapped few-shot | DSPy BootstrapFewShot | ~50 | ~20 conversations |
| Textual feedback in metrics | GEPA | ~10 | Stage 4 |
| Instruction candidate generation | MIPROv2 | ~30 | Stage 4 |
| Playbook with delta edits | Ax ACE | ~100 | Stage 4 |

**ACE loop:** Generator (base program + evolving playbook) -> Reflector (analyzes failures) -> Curator (applies structured deltas: add/modify/remove bullet). Living document that keeps improving.

**Agentic mismatch warning:** DSPy assumes modular optimization (change one module's prompt, only affects that module). Our agent uses the same system prompt at every step. Optimize at system-prompt level (ACE playbook), not individual tool-call level.

### Stage 5: Signal Pipeline `[research]`
**Trigger:** ~100 conversations, stable evaluation rubrics
**What:** Full capture -> evaluate -> rewrite -> test -> deploy loop.
**Implementation:** ACE-style playbook deltas with automated signal capture from conversation outcomes.

**Signal capture schema:**
```sql
CREATE TABLE signals (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,  -- 're-ask', 'correction', 'task_completion', 'result_usage', 'sentiment'
  content TEXT NOT NULL,
  reliability TEXT NOT NULL,  -- 'high', 'medium', 'low'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Signal types and reliability:**

| Signal | Reliability | Example |
|-|-|-|
| Re-asks | High | User rephrases question — agent missed the point |
| Corrections | High | "No, I meant..." — explicit feedback |
| Task completion | High | User confirms task is done |
| Result usage | Medium | User acts on agent's output |
| Sentiment alone | Very low | ~80% false-positive rate (PAI finding) — never use alone |

**Anti-patterns to enforce:** no instruction bloat, no contradictory rules, no over-specificity. Verification gate checks coherence before promoting.

### Stage 6: Evolutionary Search `[research]`
**Trigger:** Multiple optimization dimensions, sufficient compute budget
**What:** Bounded code mutation with tree-structured archive, lineage tracing, human gate.
**Implementation:** DGM pattern with safety guardrails.

## Safety Patterns (Non-Negotiable) `[confirmed]`

| Pattern | Why |
|-|-|
| Lineage tracing | DGM fabricated test results — only caught via full change tracking |
| Sandbox always | bubblewrap/container for any generated code execution |
| Separate evaluation from execution | Evaluator must not run evaluated code |
| Max 5 evolutions per cycle | Wang & Dorchen proof: unbounded self-improvement breaks learnability |
| Allowlist not denylist | For tool/capability access |
| Test before trust | Run on held-out set before promoting |
| Human review for code changes | Inngest `waitForEvent()` + Telegram approval |
| Overfitting guard | Forbid referencing specific examples in optimized prompts (Dropbox lesson) |

## Stage 4 Graduation Features `[research]`

Add these incrementally as complexity demands:

| Feature | Trigger | Source |
|-|-|-|
| Bayesian optimization (TPE) | 3+ interacting LLM calls | MIPROv2 |
| Pareto frontier | Multiple quality dimensions that trade off | GEPA |
| Reflective mutation | Pre-generated candidates miss failure modes | GEPA |
| Module credit assignment | Long multi-step pipelines | MIPROv2 |
| Crossover/merge | Complementary strengths across lineages | DGM |

## Build Order `[confirmed]`

1. ~~Stage 1 (correction extraction) + Stage 3 (typed calls + retry)~~ — shipped
2. Stage 2 (skill library) — when first repeated task appears
3. Evaluation rubrics — define per task type as they emerge
4. Bootstrapped few-shot — when ~20 real conversations exist
5. Stage 4 (prompt optimization) — when ~50 labeled examples
6. Stages 5-6 — when data volume and compute budget justify

## Dual-Mode Monitoring `[research]`

From memU. For ingestion agents: cheap embedding scan first, LLM only when relevant. Saves ~30% of ingestion costs by filtering before LLM processing.

## Audit Log & Manual Trigger `[confirmed]`

The Observer's structured output (`ObserverResult`) was originally only logged. Two product surfaces sit on top of an append-only audit row per Observer fire:

- **Read:** `/learned` in Telegram — digest of recent evolution events; `/learned <id>` for one event's detail.
- **Trigger:** `/reflect` in Telegram — runs the Observer for the current conversation synchronously, replies with a one-line summary.

Both share the same persistence model. Industry validation in [decisions.md](decisions.md) → Evolution audit log + manual trigger.

### `evolution_events` table

Append-only, one row per Observer fire (`status: "processed"` only — skipped fires don't earn a row since there's nothing to surface). Owned by `agent/store/schema.ts`.

| Column | Type | Notes |
|-|-|-|
| `id` | UUIDv7 PK | DB-generated |
| `conversation_id` | UUID NOT NULL | FK → `conversations.id`; the Observer's fire trigger. Append-only — never re-pointed, so cascade is unnecessary. |
| `user_id` | UUID NOT NULL | FK → `users.id`; denormalised from the conversation to make `/learned` lookups a single index scan. |
| `triggered_by` | text NOT NULL | `"idle"` (autonomous fire on `conversation/idle`) or `"manual"` (`/reflect`). pgEnum `evolution_trigger`. |
| `payload` | JSONB NOT NULL | The `ObserverResult` extended with the trigger metadata; validated via `EvolutionEventPayloadSchema`. |
| `created_at` | TIMESTAMPTZ NOT NULL | `now()` default. |

Index: `(user_id, created_at DESC)` for the `/learned` digest path.

**Why one row per fire, not per atomic change.** Atomic-change granularity (one row per rule promoted / memory written) duplicates information the underlying tables already carry (`steering_rules.observation_count`, Hindsight write timestamps) and forces the digest path to fan out across kinds. The Observer's per-fire output is already a natural unit: counts + per-rule outcomes + extraction reasoning live in one structured object. Per-fire rows let the digest summarise a fire in one line and the detail view show the full reasoning trace without joins.

**Why denormalise `user_id` from `conversations.user_id`.** The digest is per-user (`/learned` shows what *I* learned across all my conversations) and `conversations` is large; scanning by `conversation_id IN (SELECT ...)` defeats the index. Append-only + immutable conversation ownership means the denormalisation can't drift.

**Why no `outcome` / `reverted_at` columns yet.** Undo / per-rule revert are deliberately deferred — the digest is the smallest useful slice that earns the table. When undo lands, add `superseded_at` + a reverse-event row rather than mutating the original (DGM pattern: append, never overwrite).

### `EvolutionEventPayloadSchema`

Wraps the Observer's existing `ObserverResult` (the `status: "processed"` variant) plus the trigger context. Defined in `src/agent/evolution/event-schema.ts` and consumed via `jsonbZod`. Fields:

- `corrections` — `{extracted, reinforced, contradictions, promoted, outOfScopeReinforcementsSkipped, unknownRuleReinforcementsSkipped, consolidationNeeded}` from `ExtractionResult`.
- `consolidation` — nullable; the `consolidateRules` result when it ran.
- `memories` — `{extracted, byNetwork}` from `MemoryExtractionResult`.
- `drained` — `{drained, byNetwork}` from the pending-memory drain step.
- `messageCount` — transcript length at fire time (the gating value against `MIN_MESSAGES_FOR_EXTRACTION`).
- `profileId` — the profile active for the conversation at fire time. Stored so the digest can render "from profile X" without a join.
- `durationMs` — wall-clock duration of the fire, optional. Stamped at the end of `runObserver` from a `Date.now()` snapshot taken at the top, so it captures "how long the operator waited" rather than "how long the successful retry's LLM calls took." Surfaced in the detail view as `Took: 32s` so a regression in extraction latency is visible per fire without grepping logs.

### Observer integration

After the `processed` branch in `runObserver` (`src/agent/evolution/observer.ts`) finishes its existing work, a single `step.run("persist-evolution-event", …)` writes the row via `agentStore.recordEvolutionEvent`. Wrapped in its own `step.run` so the persistence is memoised separately from the LLM-bearing steps — a retry after a successful extraction-and-retain doesn't re-spend tokens, just retries the DB write. `skipped` results don't persist (nothing happened worth surfacing).

The `triggered_by` value is threaded as an optional parameter to `runObserver` (default `"idle"`). The autonomous Inngest function passes nothing; the manual trigger (`/reflect`) passes `"manual"`. The event schema (`conversation/idle`) stays unchanged — this is a runtime detail, not an event-bus contract.

### Manual trigger (`/reflect`)

The Telegram command resolves the current conversation, calls `transport.evolution.triggerReflection(conversationId)`, and replies with one of:

- `"Conversation too short to reflect on yet (need ≥4 messages)."` — Observer returned `{status: "skipped", reason: "too_short"}`.
- `"No active conversation."` — no session for the address.
- `"Reflected — N rules extracted, M memories. /learned for details."` — the digest of the `ProcessedObserverResult`.

`triggerReflection` invokes `runObserver` directly (not via Inngest) with a step harness that just calls the closure — single-user, immediate feedback wins over durability for an explicitly-user-initiated debug action. The autonomous idle path keeps the full Inngest pipeline (concurrency limit per `conversationId`, retry budget, memoisation).

**Concurrency-cap bypass, acknowledged.** The autonomous Inngest function is registered with `concurrency: { limit: 1, key: "event.data.conversationId" }` — at most one in-flight Observer per conversation. `/reflect` sidesteps that registry entirely. If a `/reflect` fires while an idle run is in flight for the same conversation, both succeed independently: two LLM extractions, two audit rows, overlapping transcript windows. At single-user scale (one operator, one tap on `/reflect`) the window for this is human-scale and the cost is two extra audit rows — benign. If/when this gets wider use, the right guard is a `pg_advisory_xact_lock(hashtext('observer:' || conversation_id))` at the top of `runObserver` (cheap, predicate-free, releases on tx commit) rather than reaching for the Inngest cap from the manual path — which would re-introduce async-reply UX and lose the in-chat digest.

**Wall-clock budget.** The handler sends a "Reflecting on this conversation…" pre-message and then awaits the full pipeline (corrections + memories + drain) end-to-end. Practical budget: 10–60 s on Claude/GPT-class models, longer on slower providers. The autonomous idle path falls back to Inngest's per-function timeout if the LLM hangs; the manual path has no such backstop — a wedged provider call blocks the reply until the LLM SDK eventually times out (~minutes). Mitigations not yet implemented but worth considering when the pattern bites: a timer-driven "this may take another minute" follow-up, or a hard `AbortSignal` on the LLM calls capped at e.g. 90 s.

### Read surface (`/learned`)

- `/learned` — last 10 events for the user, one line per event: `id timestamp from profile-name: N rules, M memories`.
- `/learned <id>` — full detail: trigger source, message count, corrections breakdown (extracted / reinforced / promoted / contradictions), memory counts by network, consolidation summary if it ran. No reasoning trace surfaced yet (the per-correction reasoning lives in the LLM response and isn't currently captured in `ExtractionResult` — surfacing it is a follow-up that requires extending the extractor's return shape).

### Deferred (intentionally)

- **Inline "noted: X" pill** on the next assistant turn — adds chat noise on every fire; the documented anti-pattern is alert fatigue. Revisit after a week of digest-based use.
- **Undo / per-rule revert** — requires the append-only pattern's reverse-event shape. Cheap once needed; useless without first feeling the pain.
- **Reasoning trace in detail view** — requires `ExtractionResult` and `MemoryExtractionResult` to surface the per-item `reasoning` field. One-line change to each, but worth landing once the digest UX is in actual use and proves it's the missing piece.

### Forward consideration: deleting a conversation

`evolution_events.conversation_id` is a FK with `ON DELETE no action`. Deliberate — audit rows are append-only, and silently cascading them away on conversation delete defeats the whole point of an audit log. The trade-off: until a delete-conversation command lands, there's no friction. Once one does, it'll need an explicit choice — either refuse the delete while audit rows exist (force the operator to `/learned undo` first, when undo lands), null out `conversation_id` on the audit row (keeps the lineage but loses the back-reference), or move the audit row into a tombstoned shape with the conversation snapshot inlined. Pick at the point of building the delete path; flagged here so it's not a surprise.
