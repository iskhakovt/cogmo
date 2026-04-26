import { z } from "zod";
import type { TaskContainerHandle } from "../../sandbox/index.js";
import type { BackendCallContext, BackendUsage, CodingBackend, CodingEvent } from "./backend.js";
import { readJsonl } from "./jsonl.js";
import { buildPlanPrompt } from "./prompt.js";

/**
 * Subset of Claude Code's stream-json events we read. Schema is permissive
 * (`passthrough`) — Anthropic adds new fields without bumping the contract,
 * and we only narrow what we depend on.
 */
const ClaudeEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("system"),
      subtype: z.string().optional(),
      session_id: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("assistant"),
      message: z
        .object({
          content: z.array(z.unknown()).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("user"),
      message: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("stream_event"),
      event: z
        .object({
          type: z.string(),
          delta: z
            .object({
              type: z.string().optional(),
              text: z.string().optional(),
            })
            .passthrough()
            .optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("result"),
      subtype: z.string().optional(),
      is_error: z.boolean().optional(),
      total_cost_usd: z.number().optional(),
      usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
]);

const PLAN_FLAGS: readonly string[] = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--input-format",
  "stream-json",
  "--permission-mode",
  "plan",
  "--verbose",
];

interface ClaudeCodeBackendOptions {
  /** Override the binary name. Defaults to `claude` (must be on PATH inside the container). */
  binary?: string;
}

export class ClaudeCodeBackend implements CodingBackend {
  #binary: string;

  constructor(opts: ClaudeCodeBackendOptions = {}) {
    this.#binary = opts.binary ?? "claude";
  }

  plan(ctx: BackendCallContext): AsyncIterable<CodingEvent> {
    const prompt = buildPlanPrompt(ctx.task, ctx.repo);
    return runClaude(this.#binary, ctx.container, PLAN_FLAGS, prompt);
  }
}

async function* runClaude(
  binary: string,
  container: TaskContainerHandle,
  flags: readonly string[],
  prompt: string,
): AsyncIterable<CodingEvent> {
  const exec = await container.exec([binary, ...flags], { attachStdin: true });

  // First and only stdin message: the user's prompt as a stream-json frame.
  // The `claude` CLI closes the session on EOF.
  if (!exec.stdin) throw new Error("ClaudeCodeBackend: stdin not attached");
  const userMessage = {
    type: "user",
    message: { role: "user", content: prompt },
  };
  exec.stdin.write(`${JSON.stringify(userMessage)}\n`);
  exec.stdin.end();

  let plan = "";
  let usage: BackendUsage | undefined;
  let resultIsError = false;
  let sessionEmitted = false;

  for await (const raw of readJsonl(exec.stdout)) {
    const parsed = ClaudeEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const event = parsed.data;

    if (event.type === "system") {
      if (event.subtype === "init" && event.session_id && !sessionEmitted) {
        sessionEmitted = true;
        yield { kind: "session_started", sessionId: event.session_id };
      }
      continue;
    }

    if (event.type === "stream_event") {
      const delta = event.event?.delta;
      if (
        event.event?.type === "content_block_delta" &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        plan += delta.text;
        yield { kind: "text_delta", text: delta.text };
      }
      continue;
    }

    if (event.type === "result") {
      resultIsError = event.is_error === true;
      usage = {
        ...(event.usage?.input_tokens != null && { inputTokens: event.usage.input_tokens }),
        ...(event.usage?.output_tokens != null && { outputTokens: event.usage.output_tokens }),
        ...(event.total_cost_usd != null && { costUsd: event.total_cost_usd }),
      };
      // `--include-partial-messages` already streamed every text delta; the
      // accumulated buffer IS the plan. No need to re-derive from any final
      // assistant message.
      if (!resultIsError && plan.length > 0) {
        yield { kind: "plan_ready", plan };
      }
    }

    // assistant / user events carry no info we need beyond what stream_event
    // already gave us in plan mode (no tool calls, no deltas worth duplicating).
  }

  const { exitCode } = await exec.wait();
  yield {
    kind: "complete",
    exitCode,
    isError: resultIsError || exitCode !== 0,
    ...(usage && { usage }),
  };
}
