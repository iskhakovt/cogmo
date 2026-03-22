# Self-Evolution

First-class feature from day one. Six stages, each a complete working system. Stages unlock with data thresholds, not calendar dates.

## 6-Stage Ladder

### Stage 1: Instruction Evolution
**Trigger:** Day 1
**What:** Corrections saved to persistent instruction file, loaded next session (CLAUDE.md pattern).
**Implementation:** JSON/YAML file in data dir. Agent appends corrections. Orchestrator loads into system prompt.
**Graduation:** Rule graduation — observation seen 2+ times promoted from "learning" to "rule". Consolidation at 30+ entries (Claude summarizes).

### Stage 2: Skill Library
**Trigger:** When agent repeatedly does the same multi-step task
**What:** Agent writes reusable code tools. Human reviews before promotion.
**Implementation:** Voyager pattern — `skills/code/` + `skills/description/`. Description embedding is retrieval key. Skills are compositional (new skills build on old ones).
**Review gate:** BullMQ `waitForEvent()` pauses until human approves via Telegram callback.
**Standard:** SKILL.md progressive disclosure:
- Tier 1: Name + description (~50 tokens, always loaded)
- Tier 2: Full instructions (~500 tokens, on trigger)
- Tier 3: Scripts/assets (on demand)

Phase transition at ~50-100 skills — need hierarchical organization.

### Stage 3: Typed Calls + Retry
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

### Stage 4: Prompt Optimization
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

### Stage 5: Signal Pipeline
**Trigger:** ~100 conversations, stable evaluation rubrics
**What:** Full capture -> evaluate -> rewrite -> test -> deploy loop.
**Implementation:** ACE-style playbook deltas with automated signal capture from conversation outcomes.

### Stage 6: Evolutionary Search
**Trigger:** Multiple optimization dimensions, sufficient compute budget
**What:** Bounded code mutation with tree-structured archive, lineage tracing, human gate.
**Implementation:** DGM pattern with safety guardrails.

## Safety Patterns (Non-Negotiable)

| Pattern | Why |
|-|-|
| Lineage tracing | DGM fabricated test results — only caught via full change tracking |
| Sandbox always | bubblewrap/container for any generated code execution |
| Separate evaluation from execution | Evaluator must not run evaluated code |
| Max 5 evolutions per cycle | Wang & Dorchen proof: unbounded self-improvement breaks learnability |
| Allowlist not denylist | For tool/capability access |
| Test before trust | Run on held-out set before promoting |
| Human review for code changes | BullMQ `waitForEvent()` + Telegram approval |
| Overfitting guard | Forbid referencing specific examples in optimized prompts (Dropbox lesson) |

## Build Order

1. Stage 1 (instruction file) + Stage 3 (typed calls + retry) — ship together, day 1
2. Stage 2 (skill library) — when first repeated task appears
3. Evaluation rubrics — define per task type as they emerge
4. Bootstrapped few-shot — when ~20 real conversations exist
5. Stage 4 (prompt optimization) — when ~50 labeled examples
6. Stages 5-6 — when data volume and compute budget justify
