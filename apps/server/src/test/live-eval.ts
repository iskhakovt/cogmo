/**
 * Shared harness for the live evals (design/testing.md → Live Tests). A turn
 * runs through the production prompt (`DefaultPromptSource` with the built-in
 * service guidance and the seeded default profile), the built-in tool
 * definitions and `runStreamingAgentLoop`, on the seeded profile's model.
 * Steering rules come from the caller; recalled context and the per-turn
 * image, sub-agent, skill and MCP tools are left out.
 *
 * The core-memory tools run their production handlers against an in-memory
 * `EvalCoreMemory`, which the prompt's `# User` section also renders from, so
 * a later turn sees what an earlier one wrote. Every other handler returns a
 * canned result: nothing is persisted and nothing outside the model is called.
 *
 * `EVAL_REPEATS` (default 1) runs every case that many times. Summary rates
 * count every sample, and each repeat's own rate follows in brackets.
 */

import * as R from "remeda";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { BUILT_IN_SERVICE_GUIDANCE, builtInToolSpecs } from "../agent/built-ins.js";
import { createDocumentTools } from "../agent/document-tools.js";
import { type AgentLoopResult, runStreamingAgentLoop } from "../agent/loop.js";
import { DefaultPromptSource, formatUserContext } from "../agent/prompt.js";
import type { CoreMemoryBlock, Service } from "../agent/service.js";
import type { Profile } from "../agent/store/index.js";
import { createDefaultTools, ToolRegistry } from "../agent/tools.js";
import { createWebTools } from "../agent/web-tools.js";
import { resolveLimits } from "../llm/models.js";
import type { LlmProvider } from "../llm/provider.js";
import type { Message, Usage } from "../llm/types.js";
import { sumUsage } from "../llm/usage.js";
import { logger } from "../logger.js";
import { DEFAULT_BASE_PROMPT, DEFAULT_PROFILE_MODEL } from "../setup/seed.js";
import type { AttachmentStore } from "../transport/attachment-store.js";

// An empty `ANTHROPIC_API_KEY=` line in `.env` counts as unset.
export const LIVE_API_KEY =
  (process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY) || undefined;

export const EVAL_MODEL = process.env.LIVE_MODEL ?? DEFAULT_PROFILE_MODEL;

/** Samples per case. */
export const EVAL_REPEATS = z.coerce
  .number()
  .int()
  .positive()
  .default(1)
  .parse(process.env.EVAL_REPEATS);

/** Every run once per repeat, case by case, tagged with its 0-based repeat. */
export function withRepeats<T extends object>(
  runs: ReadonlyArray<T>,
): Array<T & { repeat: number }> {
  return runs.flatMap((run) => R.range(0, EVAL_REPEATS).map((repeat) => ({ ...run, repeat })));
}

/** A summary row: the samples in `of` for which `hit` holds. */
export interface EvalMetric<O> {
  name: string;
  of: (o: O) => boolean;
  hit: (o: O) => boolean;
}

/**
 * Each metric's rate per group, as `hits/samples` over every repeat, followed
 * by each repeat's own rate in brackets when there is more than one.
 */
export function rateTable<O extends { repeat: number }>(
  metrics: ReadonlyArray<EvalMetric<O>>,
  groups: Readonly<Record<string, ReadonlyArray<O>>>,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    metrics.map((m) => [
      m.name,
      R.mapValues(groups, (group) => {
        const rate = (samples: ReadonlyArray<O>) => {
          const population = samples.filter(m.of);
          return `${population.filter(m.hit).length}/${population.length}`;
        };
        if (EVAL_REPEATS === 1) return rate(group);
        const perRepeat = R.range(0, EVAL_REPEATS).map((i) =>
          rate(group.filter((o) => o.repeat === i)),
        );
        return `${rate(group)} [${perRepeat.join(" ")}]`;
      }),
    ]),
  );
}

const EVAL_TIMEZONE = "Europe/London";

/** The seeded default profile: every tool, the seeded base prompt. */
export const EVAL_PROFILE: Profile = {
  id: "01999a00-0000-7000-8000-000000000001",
  userId: null,
  name: "assistant",
  basePrompt: DEFAULT_BASE_PROMPT,
  model: EVAL_MODEL,
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

export const CoreMemoryBlocksSchema = z.array(z.object({ key: z.string(), content: z.string() }));

const CoreMemoryUpdateInputSchema = z.object({ key: z.string(), content: z.string() });

const MEMORY_TOOLS: ReadonlySet<string> = new Set([
  "core_memory_update",
  "core_memory_read",
  "memory_retain",
  "memory_recall",
  "memory_reflect",
]);

type CoreMemoryNamespace = Service["coreMemory"];

/** A user's core memory held in process, in the key order the store returns it. */
export class EvalCoreMemory implements CoreMemoryNamespace {
  #blocks: Map<string, string>;

  constructor(blocks: ReadonlyArray<CoreMemoryBlock>) {
    this.#blocks = new Map(blocks.map((b) => [b.key, b.content]));
  }

  async get(): Promise<ReadonlyArray<CoreMemoryBlock>> {
    return R.sortBy(
      [...this.#blocks].map(([key, content]) => ({ key, content })),
      R.prop("key"),
    );
  }

  async update(key: string, content: string): Promise<void> {
    this.#blocks.set(key, content);
  }
}

/** The production tool definitions; handlers other than core memory's return canned results. */
function evalTools(): ToolRegistry {
  const production = createDefaultTools(
    builtInToolSpecs({
      webTools: createWebTools(undefined, undefined),
      documentTools: createDocumentTools(mock<AttachmentStore>()),
    }),
    EVAL_TIMEZONE,
  );
  const tools = new ToolRegistry();
  for (const spec of production.snapshot()) {
    tools.register(
      spec.name.startsWith("core_memory_")
        ? spec
        : { ...spec, handler: async () => cannedResult(spec.name) },
    );
  }
  return tools;
}

function cannedResult(tool: string): string {
  switch (tool) {
    case "memory_retain":
      return "Remembered.";
    case "memory_recall":
    case "memory_reflect":
      return "No relevant memories found.";
    default:
      return "Unavailable in this environment.";
  }
}

export interface EvalTurn {
  systemPrompt: string;
  result: AgentLoopResult;
}

/** One turn: assemble the prompt from the current core memory and `rules`, then run the loop. */
export async function runEvalTurn(params: {
  provider: LlmProvider;
  coreMemory: EvalCoreMemory;
  rules: ReadonlyArray<{ rule: string }>;
  history: ReadonlyArray<Message>;
  message: string;
  cacheKey: string;
}): Promise<EvalTurn> {
  const { coreMemory } = params;
  const tools = evalTools();
  const systemPrompt = await new DefaultPromptSource({
    timezone: EVAL_TIMEZONE,
    serviceGuidance: BUILT_IN_SERVICE_GUIDANCE,
    getUserContext: async () => formatUserContext(await coreMemory.get()),
  }).assemble({ profile: EVAL_PROFILE, rules: params.rules, toolDefinitions: tools.definitions() });

  const result = await runStreamingAgentLoop({
    provider: params.provider,
    model: EVAL_MODEL,
    systemPrompt,
    messages: [...params.history, { role: "user", content: params.message }],
    tools,
    service: { memory: mock<Service["memory"]>(), files: mock<Service["files"]>(), coreMemory },
    maxTokens: resolveLimits(EVAL_MODEL).maxOutputTokens,
    onEvent: async () => {},
    cache: { key: params.cacheKey, retention: "short" },
    turnLogger: logger,
  });
  return { systemPrompt, result };
}

export interface EvalConversation {
  /** Every message in order, as the conversation would persist it. */
  history: Message[];
  turns: EvalTurn[];
  /** Core memory after each turn. */
  blocksAfter: Array<ReadonlyArray<CoreMemoryBlock>>;
}

/** Scripted user messages, one turn each; every turn sees the history and core memory so far. */
export async function runEvalConversation(params: {
  provider: LlmProvider;
  coreMemory: EvalCoreMemory;
  rules: ReadonlyArray<{ rule: string }>;
  messages: ReadonlyArray<string>;
  cacheKey: string;
}): Promise<EvalConversation> {
  const history: Message[] = [];
  const turns: EvalTurn[] = [];
  const blocksAfter: Array<ReadonlyArray<CoreMemoryBlock>> = [];
  for (const message of params.messages) {
    const turn = await runEvalTurn({ ...params, history, message });
    history.push({ role: "user", content: message }, ...turn.result.newMessages);
    turns.push(turn);
    blocksAfter.push(await params.coreMemory.get());
  }
  return { history, turns, blocksAfter };
}

/** Memory tool calls per assistant message, in iteration order. */
export function memoryCallsByIteration(
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

/** The `core_memory_update` calls in `messages`, in call order. */
export function coreMemoryWrites(messages: ReadonlyArray<Message>): CoreMemoryBlock[] {
  return memoryCallsByIteration(messages)
    .flat()
    .flatMap((c) => {
      if (c.name !== "core_memory_update") return [];
      const parsed = CoreMemoryUpdateInputSchema.safeParse(c.input);
      return parsed.success ? [parsed.data] : [{ key: "(unparsed)", content: "" }];
    });
}

/**
 * Relative time words, which go stale in a block that every later prompt
 * shows: "recently" still reads as recent months on.
 */
const RELATIVE_TIME =
  /\b(?:recent(?:ly)?|just|today|tonight|yesterday|tomorrow|ago|(?:this|last|next) (?:week(?:end)?|month|year))\b/gi;

/** The relative time words in `content`, lower-cased, in order. */
export function relativeTimeWords(content: string): string[] {
  return (content.match(RELATIVE_TIME) ?? []).map((w) => w.toLowerCase());
}

/** Token usage summed across an eval run. */
export interface UsageMeter {
  add(usage: Usage): void;
  /** `provider`, with the usage of every `chat` call added to this meter. */
  metered(provider: LlmProvider): LlmProvider;
  /** Input includes the cache reads and writes. */
  summary(): string;
}

export function createUsageMeter(): UsageMeter {
  let total: Usage = { inputTokens: 0, outputTokens: 0 };
  const meter: UsageMeter = {
    add: (usage) => {
      total = sumUsage(total, usage);
    },
    metered: (provider) => ({
      name: provider.name,
      chat: async (params) => {
        const response = await provider.chat(params);
        meter.add(response.usage);
        return response;
      },
      chatStream: (params) => provider.chatStream(params),
      countTokens: (params) => provider.countTokens(params),
    }),
    summary: () =>
      `input ${total.inputTokens} (cache read ${total.cacheReadTokens ?? 0}, ` +
      `cache write ${total.cacheCreationTokens ?? 0}), output ${total.outputTokens}`,
  };
  return meter;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
