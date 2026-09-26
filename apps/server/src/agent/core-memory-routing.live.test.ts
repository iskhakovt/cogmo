/**
 * Live eval: does the agent write what it learns about the user to core
 * memory when it should, and only then? The routing rule it measures is
 * design/memory.md → Core Memory vs Hindsight.
 *
 * Each labelled case in `test/fixtures/evals/core-memory-routing.json` is one
 * single-turn conversation through the production prompt (`DefaultPromptSource`
 * with the built-in service guidance and the seeded profile's base prompt),
 * the built-in tool definitions and `runStreamingAgentLoop`, on the seeded
 * profile's model. Every tool handler is a stub returning a canned result, so
 * nothing is persisted and nothing outside the model is called. Each case runs
 * in two core-memory states: empty, where the prompt shows the onboarding
 * text, and established, holding the fixture's blocks. Steering rules,
 * recalled context and the per-turn image, sub-agent, skill and MCP tools are
 * left out. It also checks what a core write says: whether it targets one of
 * the case's expected blocks and, in the established state, which established
 * lines the rewritten block lost and whether it still holds what the case
 * ends.
 *
 * It reports rather than asserts. One sample per case on a non-deterministic
 * model makes any threshold either too loose to catch a regression or flaky,
 * so the per-case calls and the summary rates are printed for a human to
 * compare against the numbers recorded in design/memory.md. The test fails
 * only when a turn does not complete.
 *
 * Skipped unless `LIVE=1` and `ANTHROPIC_API_KEY` are set. A full run is 57
 * turns on Sonnet 5, on the order of a dollar.
 *
 *   set -a; . ./.env; set +a; LIVE=1 pnpm test:live src/agent/core-memory-routing.live.test.ts
 *
 * `EVAL_CASES` (comma-separated case ids) narrows the run; `LIVE_MODEL`
 * overrides the model.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as R from "remeda";
import { afterAll, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { AnthropicProvider } from "../llm/anthropic.js";
import { resolveLimits } from "../llm/models.js";
import type { Message } from "../llm/types.js";
import { logger } from "../logger.js";
import { DEFAULT_BASE_PROMPT, DEFAULT_PROFILE_MODEL } from "../setup/seed.js";
import { expectDefined } from "../test/assertions.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { BUILT_IN_SERVICE_GUIDANCE, builtInToolSpecs } from "./built-ins.js";
import { createDocumentTools } from "./document-tools.js";
import { runStreamingAgentLoop } from "./loop.js";
import { DefaultPromptSource, formatUserContext } from "./prompt.js";
import type { CoreMemoryBlock, Service } from "./service.js";
import type { Profile } from "./store/index.js";
import { createDefaultTools, ToolRegistry, type ToolSpec } from "./tools.js";
import { createWebTools } from "./web-tools.js";

// An empty `ANTHROPIC_API_KEY=` line in `.env` counts as unset.
const API_KEY = (process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY) || undefined;

const MODEL = process.env.LIVE_MODEL ?? DEFAULT_PROFILE_MODEL;

const TIMEZONE = "Europe/London";

const RoutingSchema = z.enum(["core", "hindsight", "none"]);
type Routing = z.infer<typeof RoutingSchema>;

const StateSchema = z.enum(["empty", "established"]);

/** An established block, one entry per line. Anchors are the single words that carry the line's fact. */
const EstablishedBlockSchema = z.object({
  key: z.string(),
  lines: z
    .array(
      z.object({
        text: z.string(),
        anchors: z.array(z.string().regex(/^[A-Za-z0-9]+$/)).nonempty(),
      }),
    )
    .nonempty(),
});
type EstablishedBlock = z.infer<typeof EstablishedBlockSchema>;

const EvalFileSchema = z.object({
  established: z.array(EstablishedBlockSchema),
  cases: z.array(
    z.object({
      id: z.string(),
      expect: RoutingSchema,
      inPassing: z.boolean().optional(),
      state: StateSchema.optional(),
      message: z.string(),
      note: z.string(),
      keys: z.array(z.string()).optional(),
      changes: z.array(z.string()).optional(),
      drops: z.array(z.string()).optional(),
    }),
  ),
});

const CoreMemoryUpdateInputSchema = z.object({ key: z.string(), content: z.string() });

const MEMORY_TOOLS: ReadonlySet<string> = new Set([
  "core_memory_update",
  "core_memory_read",
  "memory_retain",
  "memory_recall",
  "memory_reflect",
]);

const EVAL = EvalFileSchema.parse(
  JSON.parse(
    readFileSync(join(process.cwd(), "test/fixtures/evals/core-memory-routing.json"), "utf8"),
  ),
);

const ONLY = process.env.EVAL_CASES?.split(",").map((id) => id.trim());

const STATES: ReadonlyArray<{
  state: z.infer<typeof StateSchema>;
  established: ReadonlyArray<EstablishedBlock>;
}> = [
  { state: "empty", established: [] },
  // In key order, as `getCoreMemoryBlocks` returns them.
  { state: "established", established: R.sortBy(EVAL.established, (b) => b.key) },
];

const RUNS = STATES.flatMap(({ state, established }) =>
  EVAL.cases
    .filter((c) => ONLY === undefined || ONLY.includes(c.id))
    .filter((c) => c.state === undefined || c.state === state)
    .map((c) => ({
      ...c,
      name: `${state}/${c.id}`,
      state,
      established,
      blocks: established.map(
        (b): CoreMemoryBlock => ({ key: b.key, content: b.lines.map((l) => l.text).join("\n") }),
      ),
    })),
);

type Run = (typeof RUNS)[number];

/** The seeded default profile: every tool, the seeded base prompt. */
const PROFILE: Profile = {
  id: "eval-profile",
  userId: null,
  name: "assistant",
  basePrompt: DEFAULT_BASE_PROMPT,
  model: MODEL,
  summarizationModel: null,
  extractionModel: null,
  autoRecall: "heuristic",
  voiceMode: "auto",
  toolSet: ["*"],
  memoryScope: null,
  profileClass: null,
  streamChunkChars: 4000,
  streamEdits: true,
  codingAutoapproveMode: "off",
};

interface Outcome {
  state: string;
  id: string;
  expect: Routing;
  /** The fact comes up while the user asks for something else. */
  inPassing: boolean;
  /** Memory tools called in the first response. */
  first: string[];
  /** Memory tools called anywhere in the turn, in call order. */
  turn: string[];
  coreWrites: ReadonlyArray<CoreMemoryBlock>;
  /** Every core write targeted one of the case's `keys`. */
  keyOk: boolean | null;
  /** Established state: established lines the rewritten blocks lost, beyond the case's `changes`. */
  lost: string[] | null;
  /** Established state: the case's `drops` a rewritten block still holds. */
  stale: string[] | null;
  reply: string;
}

const outcomes = new Map<string, Outcome>();

/** The production tool definitions, every handler replaced by a canned result. */
function stubbedTools(blocks: ReadonlyArray<CoreMemoryBlock>): ToolRegistry {
  const production = createDefaultTools(
    builtInToolSpecs({
      webTools: createWebTools(undefined, undefined),
      documentTools: createDocumentTools(mock<AttachmentStore>()),
    }),
    TIMEZONE,
  );
  const stubbed = new ToolRegistry();
  for (const spec of production.snapshot()) {
    stubbed.register({ ...spec, handler: async (input) => stubResult(spec, input, blocks) });
  }
  return stubbed;
}

function stubResult(
  spec: ToolSpec,
  input: Record<string, unknown>,
  blocks: ReadonlyArray<CoreMemoryBlock>,
): string {
  switch (spec.name) {
    case "core_memory_update":
      return `Core memory block "${String(input.key)}" updated.`;
    case "core_memory_read":
      return formatUserContext(blocks) ?? "No core memory blocks yet.";
    case "memory_retain":
      return "Remembered.";
    case "memory_recall":
    case "memory_reflect":
      return "No relevant memories found.";
    default:
      return "Unavailable in this environment.";
  }
}

/** Memory tool calls per assistant message, in iteration order. */
function memoryCallsByIteration(
  messages: ReadonlyArray<Message>,
): Array<Array<{ name: string; input: unknown }>> {
  return messages
    .filter((m) => m.role === "assistant")
    .map((m) =>
      typeof m.content === "string"
        ? []
        : m.content.flatMap((b) =>
            b.type === "tool_use" && MEMORY_TOOLS.has(b.name)
              ? [{ name: b.name, input: b.input }]
              : [],
          ),
    );
}

/**
 * A rewritten block keeps an established line while it still names every one
 * of the line's anchors: rephrasing around them passes ("London, United
 * Kingdom"), a dropped fact doesn't.
 */
function keeps(content: string, anchors: ReadonlyArray<string>): boolean {
  const tokens = new Set(content.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return anchors.every((a) => tokens.has(a.toLowerCase()));
}

function mentions(text: string, fragments: ReadonlyArray<string>): boolean {
  return fragments.some((f) => text.toLowerCase().includes(f.toLowerCase()));
}

/**
 * What the turn's core writes say: the target block in either state, and
 * against the established blocks, the lines a rewrite lost and what it still
 * holds that the case ends.
 */
function checkWrites(
  run: Run,
  writes: ReadonlyArray<CoreMemoryBlock>,
): Pick<Outcome, "keyOk" | "lost" | "stale"> {
  if (writes.length === 0) return { keyOk: null, lost: null, stale: null };
  // The last write to a key is the block the next turn sees.
  const finals = [...new Map(writes.map((w) => [w.key, w])).values()];
  const { keys, drops } = run;
  const keyOk = keys === undefined ? null : finals.every((w) => keys.includes(w.key));
  if (run.state !== "established") return { keyOk, lost: null, stale: null };

  const exempt = [...(run.changes ?? []), ...(drops ?? [])];
  const rewrites = finals.flatMap((w) => {
    const block = run.established.find((b) => b.key === w.key);
    return block ? [{ content: w.content, lines: block.lines }] : [];
  });
  return {
    keyOk,
    lost:
      rewrites.length === 0
        ? null
        : rewrites.flatMap(({ content, lines }) =>
            lines
              .filter((l) => !mentions(l.text, exempt) && !keeps(content, l.anchors))
              .map((l) => l.text),
          ),
    stale:
      drops === undefined
        ? null
        : drops.filter((d) => finals.some((w) => mentions(w.content, [d]))),
  };
}

function updates(o: Outcome): boolean {
  return o.turn.includes("core_memory_update");
}

function retains(o: Outcome): boolean {
  return o.turn.includes("memory_retain");
}

function labelled(routing: Routing): (o: Outcome) => boolean {
  return (o) => o.expect === routing;
}

/** Summary rates: each counts the outcomes in `of` for which `hit` holds. */
const METRICS: ReadonlyArray<{
  name: string;
  of: (o: Outcome) => boolean;
  hit: (o: Outcome) => boolean;
}> = [
  { name: "core recall (turn)", of: labelled("core"), hit: updates },
  { name: "  announced", of: (o) => o.expect === "core" && !o.inPassing, hit: updates },
  { name: "  in passing", of: (o) => o.expect === "core" && o.inPassing, hit: updates },
  { name: "  to an expected block", of: (o) => o.keyOk !== null, hit: (o) => o.keyOk === true },
  {
    name: "  dropping what ended",
    of: (o) => o.stale !== null,
    hit: (o) => o.stale?.length === 0,
  },
  {
    name: "core recall (first response)",
    of: labelled("core"),
    hit: (o) => o.first.includes("core_memory_update"),
  },
  {
    name: "core cases retained instead",
    of: labelled("core"),
    hit: (o) => retains(o) && !updates(o),
  },
  { name: "core writes, hindsight cases", of: labelled("hindsight"), hit: updates },
  { name: "core writes, none cases", of: labelled("none"), hit: updates },
  {
    name: "rewrites that lost a line",
    of: (o) => o.lost !== null,
    hit: (o) => (o.lost?.length ?? 0) > 0,
  },
  { name: "retains, hindsight cases", of: labelled("hindsight"), hit: retains },
  {
    name: "any memory write, none cases",
    of: labelled("none"),
    hit: (o) => updates(o) || retains(o),
  },
];

function verdict(o: Outcome): string {
  if (o.expect !== "core") return updates(o) ? "FP   " : "ok   ";
  if (!updates(o)) return "MISS ";
  return (o.stale?.length ?? 0) > 0 ? "STALE" : "ok   ";
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function report(): void {
  const rows = RUNS.flatMap((r) => {
    const o = outcomes.get(r.name);
    return o ? [o] : [];
  });
  if (rows.length === 0) return;

  console.log(`\nCore-memory routing on ${MODEL}\n`);
  for (const o of rows) {
    const keys = o.coreWrites.map((w) => w.key).join(",");
    console.log(
      `${verdict(o)} ${o.state.padEnd(11)} ${o.id.padEnd(18)} ${o.expect.padEnd(9)} ` +
        `first=[${o.first.join(",")}] turn=[${o.turn.join(",")}]` +
        `${keys ? ` keys=${keys}` : ""}${o.keyOk === false ? " (unexpected block)" : ""}`,
    );
    for (const w of o.coreWrites) console.log(`        ${w.key} := ${oneLine(w.content, 400)}`);
    if (o.lost?.length) console.log(`        lost: ${o.lost.join(" | ")}`);
    if (o.stale?.length) console.log(`        still holds: ${o.stale.join(", ")}`);
    console.log(`        reply: ${oneLine(o.reply, 120)}`);
  }

  const groups = { ...R.groupBy(rows, (o) => o.state), all: rows };
  console.table(
    Object.fromEntries(
      METRICS.map((m) => [
        m.name,
        R.mapValues(groups, (group) => {
          const population = group.filter(m.of);
          return `${population.filter(m.hit).length}/${population.length}`;
        }),
      ]),
    ),
  );
}

describe.skipIf(API_KEY === undefined)(`core-memory routing on ${MODEL} (live eval)`, () => {
  const nonce = randomUUID();

  afterAll(report);

  it.concurrent.each(RUNS)("$name", async (run) => {
    const tools = stubbedTools(run.blocks);
    const systemPrompt = await new DefaultPromptSource({
      timezone: TIMEZONE,
      serviceGuidance: BUILT_IN_SERVICE_GUIDANCE,
    }).assemble({
      profile: PROFILE,
      rules: [],
      coreMemory: run.blocks,
      toolDefinitions: tools.definitions(),
    });

    const result = await runStreamingAgentLoop({
      provider: new AnthropicProvider(expectDefined(API_KEY, "API key")),
      model: MODEL,
      systemPrompt,
      messages: [{ role: "user", content: run.message }],
      tools,
      service: mock<Service>(),
      maxTokens: resolveLimits(MODEL).maxOutputTokens,
      onEvent: async () => {},
      cache: { key: `${nonce}-${run.state}`, retention: "short" },
      turnLogger: logger,
    });

    const byIteration = memoryCallsByIteration(result.newMessages);
    const calls = byIteration.flat();
    const coreWrites = calls.flatMap((c) => {
      if (c.name !== "core_memory_update") return [];
      const parsed = CoreMemoryUpdateInputSchema.safeParse(c.input);
      return parsed.success ? [parsed.data] : [{ key: "(unparsed)", content: "" }];
    });
    outcomes.set(run.name, {
      state: run.state,
      id: run.id,
      expect: run.expect,
      inPassing: run.inPassing ?? false,
      first: (byIteration[0] ?? []).map((c) => c.name),
      turn: calls.map((c) => c.name),
      coreWrites,
      ...checkWrites(run, coreWrites),
      reply: result.text,
    });

    expect(result.degraded).toBeUndefined();
    expect(result.text).not.toBe("");
  });
});
