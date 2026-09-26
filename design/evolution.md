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
**Explicit instructions `[proposed]`:** A standing instruction the user states about the agent's behaviour becomes an active rule in the turn, through a tool, and an explicit retraction retires it; inferred corrections keep this graduation path, except that a contradiction of a rule still learning retires it rather than only being logged (**Safety** above). See [Explicit Instructions](#explicit-instructions-proposed).
**Prerequisite:** Full tool invocation history in `messages` table (landed PR #34) — correction extraction inspects `tool_use` blocks, not just text.
**Evaluation:** `src/agent/evolution/correction-learning.live.test.ts` puts each correction in `test/fixtures/evals/correction-learning.json` through two conversations, runs `extractCorrections` on each transcript against PGlite, then sends a probe message with the active rules under `# Rules` and, as a baseline, without the correction. The conversations are on Telegram, so every prompt also carries the channel rules `seedChannelRules` gives a Telegram setup, "Use bullet lists instead" of tables among them. It reports rather than asserts (see [testing.md](testing.md) → Live Tests). Two samples per scenario on `claude-sonnet-5` on the current guidance (N=2): 7 of 8 samples completed, and in all seven the first extraction produced the rule and the second reinforced it to active. With the rule, the probe reply followed it in 4 of 7: no bold 2 of 2; no bullet points 1 of 1, against the seeded rule asking for bullet lists; metric units 1 of 2, the miss giving Ben Nevis as "1,345 metres (4,411 ft)"; and a 100-word limit 0 of 2, with replies of 193 and 146 words against 340 and 279 without the rule. No reply without the correction followed it. The agent also saved every correction to the `preferences` core-memory block, so a later prompt would carry it twice. Before extraction tolerated the omission, 2 extractions in 44 across this and earlier runs threw, one of them the eighth sample here: the model left out `matchedExistingRuleId` on a `new` correction, and the one feedback retry left it out again.

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

**Phases fail independently.** Corrections, consolidation, memory extraction and the pending-memory drain each run inside `settlePhase`. A step keeps its Inngest retries; once one has failed after them, its `StepError` is logged at warn with the conversation, phase and step id, the phase reports an empty result (zero counts, `consolidation: null`), and the fire carries on to the next phase and to `persist-evolution-event`. The fallback depends only on the memoized failure, so replays plan the same steps. A failed drain stops where it failed: rows not yet deleted stay pending for the next fire. The audit row does not yet distinguish a failed phase from one that found nothing; the warn log is the only record. Errors that are not a `StepError` still propagate, so `/reflect`, whose harness has no retries, reports the failure to the user.

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

## Explicit Instructions `[proposed]`

**Problem.** Every behavioural correction is learned twice. In the correction-learning eval ([Stage 1](#stage-1-instruction-evolution-confirmed) → Evaluation), each correction was a standing instruction the user stated outright. The agent wrote it to core memory's `preferences` block in the turn, and the Observer extracted it into a steering rule that applied only once a second conversation had gone idle, so every later prompt carries it twice. A retraction ("bullets are fine again") can rewrite the block, but the Observer only logs a contradiction, so the rule stays. And seeded channel rules (priority 50, "Use bullet lists instead") render above learned ones (100) in a flat `# Rules` list that doesn't say which wins.

**Direction.** Each kind of knowledge has one store, and the write path follows how certain the evidence is:

| Kind | Store | Written | Retired |
|-|-|-|-|
| A fact about the user | Core memory | `core_memory_update`, in the turn | Rewritten in the turn |
| A standing instruction the user states about the agent's behaviour | Steering rule, `source = 'instruction'`, active at once | `rule_set`, in the turn | `rule_remove`, in the turn |
| A preference inferred from the user's reactions | Steering rule, `source = 'correction'` | The Observer at idle; active at the second observation, as today | `rule_remove` once active; a contradiction at idle while still learning |

### The Boundary

**Core memory describes the user; a rule governs the agent.** Core memory holds who the user is, their life and circumstances, and their preferences about things in the world (diet, travel, working days). A rule governs the form of replies (format, length, tone, language and spelling, units) and the agent's standing conduct (when to ask first, what never to do). The phrasing doesn't decide. An instruction that only applies a stated fact writes the fact and no rule: the fact is in every prompt already.

| Message | Goes to | Why |
|-|-|-|
| "Can you call me Sam from now on?" | Core memory | A request, but it says what the user is called, which every persona needs |
| "I've gone vegetarian, so keep that in mind when you suggest recipes." | Core memory | Diet; the instruction adds nothing to the fact |
| "Fridays are off now. Don't plan anything work-related for a Friday." | Core memory | The schedule implies the instruction |
| "Always answer me in British English, please." | Rule | The spelling of replies; nothing about the user is stated |
| "Please stop using bullet points with me." | Rule | The format of replies |
| "Metric only, I never use imperial units." | Rule | A statement about the user, but its only use is the units in replies |
| "Give me this one as a bulleted list." | Nothing | A one-off request |
| "For the rest of this chat, answer in French." | Nothing | Bounded to this chat or a period; the transcript carries it |
| "Way too long. What's the short version?" | Nothing in the turn; the Observer may infer a rule | A reaction, not a stated standing instruction |

The [routing table](memory.md#core-memory-vs-hindsight-confirmed) drops "spelling variety" from core memory and sends instructions about replies and conduct to `rule_set`. `CORE_MEMORY_PROMPT_GUIDANCE`, `MEMORY_PROMPT_GUIDANCE`, the `core_memory_update` and `memory_retain` descriptions, and the onboarding text, which asks how the user "prefer[s] to communicate", say the same, as does a rules entry in `# Capabilities`. If [Core Memory Scope by Profile Class](memory.md#core-memory-scope-by-profile-class-proposed) lands, its shared `identity` block holds the languages the user speaks, and the language and spelling of replies are rules.

### Precedence

A user's instruction beats a channel default: a default is the operator's guess about a medium, and the instruction is the user deciding. Operator rules beat both, as deliberate configuration that chat can't change, and `safety` rules are among them. Rules render in sections by authority, earlier sections winning, and the prompt says so. The source decides the section. Within a section, rules order by scope (profile-scoped, then channel-scoped, then everywhere), then `priority`, then `id`, so the narrower of two conflicting rules is listed first. Empty sections are left out.

| Section | Rows |
|-|-|
| Always | `manual`: operator rules, the only source of `safety` |
| From your user | `instruction` |
| Learned from your user | `correction`, `evolution` |
| Channel defaults | `seed`: what `seedChannelRules` writes, `manual` today ([Data Model](#data-model)) |

```
# Rules

Standing rules for your replies. Where two conflict, follow the one listed first.

## Always
- …

## From your user
Your user asked for these. They take precedence over your default style and the channel defaults.
- Don't use bullet points; write in paragraphs.

## Learned from your user
- …

## Channel defaults
- On telegram: Avoid tables — they don't render on this channel. Use bullet lists instead.
```

The channel label ("On telegram: ") is the [snapshot](prompt-caching.md#system-prompt-snapshot-proposed)'s; today's `# Rules` renders bare text, and only the active channels' channel-scoped rules. The seeded rules keep their wording, since the section order decides ([Alternatives](#alternatives-considered)). The same rendering is the first change to measure for learned rules being ignored ("Make learned rules stick" in `todo.md`): the base prompt's "Be concise … Be thorough when the topic is complex" competes with a length rule that nothing ranks.

### Tools

`rule_set` and `rule_remove` are built-ins, gated by the profile's `tool_set` like any other. As with the core-memory tools ([memory.md](memory.md#boundaries)), a profile whose `memory_scope.trust` excludes `first-party` (a null `memory_scope` admits it), or a turn whose profile can't be loaded, isn't offered them; trust is already in the configuration digest, so withholding them keeps [one prefix per conversation](prompt-caching.md#one-prefix-per-conversation-proposed). A turn the user didn't start (inbound `source <> 'user'`: a scheduled fire, a pipeline stage) refuses the call at dispatch, so the tool set doesn't change with the turn. The gate reads the class, restricted flag and trust gate that `freeze-turn-inputs` records ([memory.md](memory.md#behaviour-by-profile)). Both are `durable: true` (DB writes) and not `parallelSafe`.

| Argument | Tool | Meaning |
|-|-|-|
| `rule` | `rule_set` | The instruction as a short imperative, general and free of this conversation's details: "Keep replies under 100 words." |
| `rule` | `rule_remove` | A rule's text, copied from `# Rules` |
| `category` | `rule_set` | `style`, `domain` or `memory`, as in extraction. `safety` isn't offered. |
| `scope` | `rule_set` | `everywhere`, or a channel type when the user ties the instruction to a channel ("on Telegram, keep it short"); for "here", the channel the quoted message arrived on, since a debounced batch can span channels. The Service accepts only a channel type the user has a session on, and otherwise returns an error naming those. The rule's text doesn't name its channel: the label is rendered. |
| `quote` | both | The user's words that state the instruction or retract it, copied from their messages in this turn |
| `replaces` | `rule_set`, optional | A rule's text from `# Rules` that the new one changes or contradicts ("make it 150 words"), resolved as `rule_remove` resolves `rule`. The matches the new rule's scope covers are retired in the same transaction; a wider rule stays, listed after the new one ("on Telegram, make it 150" leaves the everywhere 100-word rule). A channel default named here stays, outranked by the new rule; an operator rule refuses the call. |

| Column | Value on `rule_set` |
|-|-|
| `source` | `instruction` |
| `active` | `true` |
| `priority` | 100; the section, not the priority, decides precedence |
| `observation_count` | 1. The Observer's reinforcements add to it, so a count above 1 usually means the user had to correct the agent again: the rule isn't sticking. A crash-window re-run or a repeated Observer fire can also add one. |
| `profile_id` | NULL: the user means the assistant, not one persona. In a profile whose class is [restricted](memory.md#memory-access-control-via-tags-confirmed), that profile, so instructions given there stay there. |
| `channel_type` | NULL for `everywhere`, otherwise the `scope` |

- **The quote must appear in the turn's user messages**, compared after normalizing case, whitespace and quote marks; otherwise the error tells the model to quote the user, or not to set a rule if the user stated none. The check tells explicit from inferred at the call and leaves the user's words in the transcript as provenance. It is not a security boundary, since text injected by a fetched page can quote any phrase the user wrote. Injection is limited by what the tools can't do (write `safety`, remove a channel default or operator rule, set or remove a rule beyond a restricted-class profile, run without a user message), by size (`rule` is capped at 200 characters in the schema, and each tool has `invocationBudget: 3` per turn) and by visibility that doesn't depend on the model: the channel notice below, and `/learned rules` ([Retraction](#retraction)).
- **Duplicates.** A live (unretired) instruction rule with the same text ([normalized](#data-model)) and scope is left as it is, and the result says it is already set. A live learned rule with that text and scope is retired in the same transaction: the instruction supersedes it. A rewording is the model's to spot: the description says not to set what `# Rules` already says, and to pass `replaces` to change a rule, including an active learned one the user now states outright.
- **Result.** `Rule set: "…". Follow it from this reply on, and confirm it to the user in a few words.` Whatever the model replies, the adapter renders a fixed channel notice from a successful `rule_set` or `rule_remove` result ("Rule saved: … · /learned rules"), as the Telegram adapter already renders `generate_image` and `send_document` results. It shows in voice mode too, where `VOICE_MODE_HINT` tells the model to skip "saved" and "noted".
- **Replay safety.** Both tools are idempotent on their natural key and need no separate idempotency key. A re-run of `rule_set` meets its own row ("already set"), its `replaces` target already retired; a re-run of `rule_remove` finds a retired rule with that text and no live match ("already removed"). Either answer is still true in place of the first attempt's. Concurrent identical sets meet the unique index ([Data Model](#data-model)).

### Retraction

`rule_remove` strips any channel label from `rule` and matches the rest against the rules the turn's `# Rules` shows ([normalized](#data-model)). Only `instruction`, `correction` and `evolution` rows are removable, and every visible match is retired: the same text in two scopes means the user meant both. In a restricted-class profile, only rules scoped to that profile are removable; the result says a wider rule can be removed only outside this persona. A rule set there is listed before a wider one it can't remove, so it wins a conflict ([Precedence](#precedence)). With no match, the result lists the removable rules verbatim for a retry.

Retiring sets `active = false` and `retracted_at`, which tells a retired rule from one still learning, so the Observer never reinforces it back to active. The row stays for `/learned rules`, which lists the rules visible to the current profile, live ones by section plus learning and retired ones, and retires one through the same path and scope limits as `rule_remove`, via Transport so every channel gets it.

| The user retracts | What happens |
|-|-|
| An instruction rule ("bullets are fine again") | `rule_remove` retires it |
| An active learned rule | The same: it is in `# Rules`, so the model can name it |
| A rule still learning, which `# Rules` doesn't show | Nothing in the turn; the Observer's contradiction at idle retires it |
| A channel default | Not removable. The result says `rule_set` can override it, since an instruction outranks a default. |
| An operator rule (`manual`, `safety` included) | Not removable. The result says only the operator changes it. |
| A change ("make it 150 words") | `rule_set` with `replaces`: the old rule is retired and the new one is active, in one transaction |

### Observer and Consolidation

| Case | Behaviour |
|-|-|
| A correction that a successful `rule_set` or `rule_remove` in the transcript recorded | The extraction prompt treats it as handled and extracts nothing for it |
| A `rule_set` that returned "already set" | A reinforcement of that rule: the user had to say it again |
| Live instruction rules | Listed among the existing rules, marked as set by the user. A `new` correction whose text matches one ([normalized](#data-model)) is dropped with a warning, as a backstop. |
| A reinforcement of an instruction rule | Adds to `observation_count`, and is never a promotion, though the row is active when the count reaches 2 |
| A contradiction of an instruction rule or an active learned rule | Logged, not applied, as today. An explicit rule changes only when the user retracts or replaces it in a turn. |
| A contradiction of a rule still learning | Retires it |
| Retired rules | Not listed, and the reinforce UPDATE matches only unretired rows, reporting a target retired meanwhile as skipped. The same reaction later starts a new learning row, which graduates as usual. |
| Consolidation | Loads `correction` and `evolution` rows only, as `getCorrections` does today. It never merges, rewrites or deletes an instruction rule. Its replace and delete skip rows retired during its LLM call (a guard on `retracted_at IS NULL`), so it never merges a retired rule into a live one. |

### Prompt Caching

- **This turn.** The tool result is in the transcript, so the reply that follows applies the rule. The system prompt is assembled once per turn, and under the [snapshot](prompt-caching.md#system-prompt-snapshot-proposed) frozen for the epoch.
- **From the next turn.** Today's per-turn assembly renders the rule under `# Rules`. Under the snapshot, a rule change alters the configuration digest, so the next turn of each of the user's open conversations opens an epoch. A rule is an instruction, so it keeps system authority rather than being announced as data.
- **Cost.** An epoch rewrites everything after the tools breakpoint, the system prompt and the transcript, at the write rate (1.25× on the 5-minute TTL, 2× on the 1-hour) where it would have been read at 0.1× on Sonnet 5: roughly one to two uncached requests' worth of input, once per change and open conversation, and it strips earlier turns' thinking blocks. Explicit rule changes are occasional, like the graduations that already open epochs. The mid-conversation `role: "system"` message that would avoid the rewrite exists on Opus 5, 5.5 and Fable but not Sonnet 5, so it is at most a later per-model optimisation.

### Data Model

- **`source` becomes the pgEnum `steering_rule_source`**: `manual`, `seed`, `instruction`, `correction`, `evolution`. `signal_pipeline` has no writer and returns with Stage 5. The migration that ships with the sectioned rendering creates the type with all five values, backfills `seed` on the rows `seedChannelRules` wrote (`manual`, its three Telegram texts, priority 50) and converts the column with `SET DATA TYPE … USING`; `seedChannelRules` writes `seed` from then on. Creating the type whole avoids an `ADD VALUE` whose value the same transaction uses ([architecture rules](../.claude/rules/architecture-rules.md)).
- **`retracted_at TIMESTAMPTZ`**, nullable, where NULL means not retired. A CHECK keeps a retired rule inactive and an instruction rule out of learning: `NOT (active AND retracted_at IS NOT NULL) AND (source <> 'instruction' OR active OR retracted_at IS NOT NULL)`.
- **A unique partial index** on `lower(regexp_replace(btrim(rule), '\s+', ' ', 'g'))`, `COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid)` and `COALESCE(channel_type, '')`, `WHERE source = 'instruction' AND retracted_at IS NULL`. The COALESCEs stand in for NULLS NOT DISTINCT, which Drizzle's index builder can't emit: only `unique()` constraints have `nullsNotDistinct()`, and those can't be partial or use expressions. The text expression is the one normalization, applied in SQL to every text match (duplicates, `rule_remove`, `replaces`, the Observer's backstop); TS only strips the channel label first. `rule_set` inserts in raw `sql`, the [code-style](../.claude/rules/code-style.md) carve-out, since `onConflictDoUpdate` takes column targets only: `ON CONFLICT DO UPDATE` with a no-op SET and `RETURNING (xmax = 0)` ([.claude/rules/inngest.md](../.claude/rules/inngest.md)).
- The tools' migration adds `retracted_at`, its CHECK and the index. Both migrations come from `pnpm db:generate`, the backfill added to the first, and the schema in [agents.md](agents.md) and the row in [data-model.md](data-model.md) change with each.

### Evaluation

**Correction learning** (`correction-learning.live.test.ts`). Like the core-memory tools, `rule_set` and `rule_remove` run their production handlers, against the sample's PGlite store. The harness re-reads rules on every turn, as production assembles them, and every other handler stays canned.

- **Explicit scenarios.** The four current scenarios all state a standing instruction. The rule must be active after the first conversation, before any extraction, and the probe runs then. The extraction on that transcript must add nothing. The second conversation adds no second instruction row and brings `observation_count` to 2, through an "already set" result or the Observer's reinforcement, since the tool description says not to set what `# Rules` shows.
- **Inferred scenario**, new: reactions that state no standing instruction, asking for Celsius after a Fahrenheit answer and then, in a second conversation, kilometres after miles, which should graduate to a metric rule. It expects no `rule_set`, a learning rule after the first extraction and an active one after the second.
- **Retraction**, new: a third conversation retracts an explicit rule ("Bullet points are fine again"), and one in the inferred scenario retracts the graduated metric rule. Each expects `rule_remove` to retire the rule in the turn, no live rule for it, nothing new from the extraction, and a probe that matches the baseline.
- **Replacement**, new: a third conversation in the 100-word scenario says "make it 150". It expects exactly one live length rule, at 150.

**Core-memory routing** (`core-memory-routing.live.test.ts`). `expect` gains `rule`: `rule_set` in the turn and no core write carrying the instruction. `british-english` moves to `rule`. New `rule` cases: "Please stop using emoji in your replies", and one in passing, "Summarise this article, and from now on keep summaries to three sentences". A new `none` case, "For the rest of this chat, answer in French", is bounded to the chat. `call-me-sam`, `vegetarian`, `meatless-dinner` and `fridays-off` stay `core`, and a `rule_set` on them counts as a false rule. The established `preferences` line, "Concise answers; tables for comparisons", is an instruction: it becomes an established rule, replaced in the block by a fact ("Prefers trains to flying"), so the established state also checks that no rewrite copies a rule into core memory.

**Success criteria**, on `claude-sonnet-5` with three samples per case. Routing counts span both states, over [memory.md](memory.md#evaluation)'s 29 cases with `british-english` moved to `rule` and the French case added:

| Metric | Target |
|-|-|
| Explicit: rule active after the first conversation | At least 11 of 12 |
| Explicit: the instruction also written to core memory | At most 1 of 12 in correction learning, 1 of 18 in routing |
| Explicit: a duplicate from extraction, or a second instruction row | 0 of 12 |
| Retraction: the rule retired in the turn | 6 of 6 |
| Replacement: one live length rule, at 150 | 3 of 3 |
| Inferred: `rule_set` called | 0 of 6 conversations |
| Routing: `rule` cases reaching `rule_set` in the turn | At least 17 of 18 |
| Routing: `rule_set` on `core`, `hindsight` or `none` cases | At most 1 of 63, 1 of 54 and 1 of 54 |
| Routing: core-memory metrics | No regression from *Current* in [memory.md](memory.md#evaluation) |
| Probe follows the rule | Reported per check, against 4 of 7 in [Stage 1](#stage-1-instruction-evolution-confirmed) → Evaluation; the length limit is tracked by "Make learned rules stick" |

This section moves to `[confirmed]` when both evals meet these targets, with the results recorded here and in [memory.md](memory.md#evaluation).

### Alternatives Considered

| Alternative | Why ruled out |
|-|-|
| Instructions in core memory only | Blocks are data. Under the [snapshot](prompt-caching.md#system-prompt-snapshot-proposed) a changed block is announced as user content, which demotes an instruction written mid-epoch. Blocks also carry no channel scope and no precedence, and are rewritten whole. |
| Explicit instructions through the Observer, graduating at 2 | "Stop using bullet points" waits for two idle conversations, and meanwhile the agent writes it to core memory, as the eval measured on every correction. None of the products below makes the user wait. |
| The Observer promoting explicit instructions on their first observation | Still waits until idle, and leaves the in-turn core write and the lagging retraction as they are |
| Ordinal labels (`R1` …) or short ids in `# Rules` for retraction | Labels shift whenever a rule is added or removed mid-conversation, and ids put noise in every rendered rule. The text is already in front of the model, and a miss returns the list to retry from. |
| Reword the seeded rules only | Any default can conflict with some later instruction, and the model still can't tell which wins |
| Renumber priorities in a flat list | Order alone doesn't tell the model which rule wins a conflict |
| No `quote` | Nothing at the call separates a stated instruction from an inference, and a fetched page could set a standing rule without the user's words anywhere in the turn |
| Explicit rules scoped to the profile by default | The user would restate every rule in each persona |
| A confirmation step before a rule applies | Adds a round-trip to every instruction. The channel notice shows the rule, `/learned rules` lists it, and `rule_remove` undoes it. |

### Prior Art

- **Letta** separates the *human* block, "information about the user, their preferences, facts about them, and relevant context", from the *persona* block, "the agent's own self-concept, personality traits, and behavioral guidelines" ([memory blocks](https://www.letta.com/blog/memory-blocks/)). In the Letta agent, `/remember always use pnpm in this repo` makes the agent decide "where the lesson belongs" and commit the update, while background "dreaming" consolidates lessons from recent conversations separately ([memory](https://docs.letta.com/letta-agent/memory)).
- **ChatGPT**: custom instructions are guidance the user writes in settings and that applies to every chat, while memory is what ChatGPT picks up from conversations ([custom instructions](https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions), [memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)).
- **Claude Code** splits by author: CLAUDE.md holds "instructions and rules" the user writes, and auto memory holds notes Claude writes "based on your corrections and preferences". CLAUDE.md loads in full every session, auto memory only as the first 200 lines of its index, with topic files read on demand. An explicit "always use pnpm, not npm" goes to auto memory at once, and to CLAUDE.md only when asked ([memory](https://code.claude.com/docs/en/memory)). The split differs from this one, but an explicit request is committed immediately.
- **Cursor**: "Rules provide persistent, reusable context at the prompt level" ([rules](https://cursor.com/docs/rules)). Its Memories were "intentionally removed starting from version 2.1.x", and staff told users to export them into Rules ([forum](https://forum.cursor.com/t/are-my-memories-gone/144057)).
- **Windsurf Cascade**: rules "tell Cascade *how to behave*", memories are auto-generated and retrieved when relevant, and "for knowledge you want Cascade to reliably reuse, write it as a Rule or add it to `AGENTS.md` in your repo rather than relying on auto-generated Memories" ([memories](https://docs.devin.ai/desktop/cascade/memories)).
- **Evidence-tracked rules.** ExpeL gives a new insight an importance count of two, up- and down-voted by later experience and "removed" at zero, because "even successful trajectories can be suboptimal and mislead the generated insights" ([Zhao et al., 2023](https://arxiv.org/html/2308.10144)). In Cui et al.'s architecture, "evidence logs track each rule's reliability across episodes", and on financial forecasting "the same accumulated experience either degrades performance below the zero-shot baseline or dramatically improves accuracy", depending on whether its curation loop is present ([2026](https://arxiv.org/abs/2606.17591)). The inferred path's graduation is stricter than the products above, none of whose pages cited here describes an evidence threshold for what the product infers.

### Implementation Outline

Step 1 can ship ahead of the tools. Steps 3, 4, 5 and 7 ship together: the Observer must know about the tools, without the guidance every instruction is stored twice, and `/learned rules` is part of the injection limits. Step 8 can follow.

1. **Source enum and precedence rendering.** The first migration in [Data Model](#data-model): the enum with all five values, the `seed` backfill and the column conversion. `seedChannelRules` writes `seed` (`insertManualRule`, whose only caller it is, becomes `insertSeedRule`), `getActiveRules` returns each rule's section, and `DefaultPromptSource` renders the sectioned `# Rules`, with `AssembleContext.rules` carrying the section. [prompt-caching.md](prompt-caching.md#system-prompt-snapshot-proposed)'s `[confirmed]` Rule order (priority, then id) changes with this step.
2. **Schema and store.** The tools' migration: `retracted_at`, its CHECK and the instruction index. Store methods to set, retire and resolve rules by text; `getCorrections`, the reinforce UPDATE and consolidation's replace and delete skip retired rows. PGlite tests: a set is idempotent, a concurrent set meets the index, retiring is idempotent, defaults can't be retired, and retired rows are never listed, reinforced or merged.
3. **Tools.** A `rules` Service namespace bound in `buildTurnService` to the turn's user text and channels and to the class, restricted flag and trust gate `freeze-turn-inputs` records ([memory.md](memory.md#behaviour-by-profile)). `rule_set` and `rule_remove`, not offered to third-party or unloadable profiles, refused at dispatch outside user turns, and added to the durable list and the crash-window table in [crash-recovery.md](crash-recovery.md). The channel notice, rendered from the tool result by the Telegram and web UI adapters. Tests cover the quote check, the channel scope, `replaces` and its scope limit, superseding a learned rule, text resolution, the no-match list, the withholding, the dispatch refusal, the notice and re-runs.
4. **Observer.** Ships with step 3: without it, the Observer extracts every explicit instruction again as a correction and graduates the copy. Instruction rules reach extraction through a read of their own, so consolidation keeps loading `correction` and `evolution` rows only. Extraction tests cover each row of [Observer and Consolidation](#observer-and-consolidation).
5. **Guidance.** The prompt text and routing table in [The Boundary](#the-boundary).
6. **Evals.** The fixture and harness changes in [Evaluation](#evaluation), with results recorded.
7. **`/learned rules`**, as described in [Retraction](#retraction).
8. **Existing `preferences` blocks.** A one-off step: ask the agent to move each behavioural line into a rule and drop it from the block.

### Open Questions

- **Observer-learned rules in restricted classes** are global (`profileId: null` in `extract-corrections.ts`). Aligning them with the explicit default needs consolidation to keep `profile_id`, the p3 per-profile consolidation entry in `todo.md`.
- **`steering_rules` has no user axis.** A global rule applies to every user's conversations: fine for one user, but a multi-user install needs `user_id` before explicit rules are safe there.
- **Restricted-class instructions scope to the profile**, since `steering_rules` has a profile axis but no class axis, while [Core Memory Scope by Profile Class](memory.md#core-memory-scope-by-profile-class-proposed) isolates core memory by class: two personas in one restricted class share core memory but not instructions. A `profile_class` column mirroring `core_memory_blocks.profile_class` is the extension if a restricted class holds several personas.
- **Operator rules have no writer but SQL** once seeding writes `seed`. An operator surface for `manual` rules (the web UI's admin API) is a separate follow-up.
- **Instructions about one persona** ("when you're my coding assistant, always write tests first") aren't expressible through the tools, which offer no profile scope. The profile's base prompt covers them for now; revisit if the eval or use shows the need.
