import { z } from "zod";
import { logger } from "../../logger.js";
import type { TaskContainerHandle } from "../../sandbox/index.js";
import type { BackendCallContext, BackendUsage, CodingBackend, CodingEvent } from "./backend.js";
import { readJsonl } from "./jsonl.js";
import { buildExecutePrompt, buildPlanPrompt } from "./prompt.js";

const log = logger.child({ component: "coding.claude" });

/**
 * Subset of Claude Code's stream-json events we read. Schema is permissive
 * (`passthrough`) — Anthropic adds new fields without bumping the contract,
 * and we only narrow what we depend on.
 */
/**
 * Block shapes inside `assistant.message.content` / `user.message.content`.
 * Anthropic's stream-json reuses the same blocks as the Messages API; we only
 * narrow the fields we surface as `tool_call` / `tool_result` events. Each
 * schema is parsed per-block via `safeParse` — unknown block types (text,
 * thinking, etc.) just fail to match and get skipped.
 */
const ToolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

const ToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    is_error: z.boolean().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();

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

/** Flags shared by every `claude -p` invocation regardless of mode. */
const COMMON_FLAGS: readonly string[] = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--input-format",
  "stream-json",
  "--verbose",
];

const PLAN_FLAGS: readonly string[] = [...COMMON_FLAGS, "--permission-mode", "plan"];

/**
 * `acceptEdits` auto-allows file edits inside the container without a human
 * prompt. The container itself is the security boundary — slice 3 layers a
 * proxy/reaper/cgroup-parent on top; until then, execute mode operates within
 * sysbox's userns and the per-task container TTL.
 */
const EXECUTE_PERMISSION_MODE = "acceptEdits";

interface ClaudeCodeBackendOptions {
  /** Override the binary name. Defaults to `claude` (must be on PATH inside the container). */
  binary?: string;
}

type RunMode = "plan" | "execute";

export class ClaudeCodeBackend implements CodingBackend {
  #binary: string;

  constructor(opts: ClaudeCodeBackendOptions = {}) {
    this.#binary = opts.binary ?? "claude";
  }

  plan(ctx: BackendCallContext): AsyncIterable<CodingEvent> {
    const prompt = buildPlanPrompt(ctx.task, ctx.repo);
    return runClaude(this.#binary, ctx.container, PLAN_FLAGS, prompt, "plan");
  }

  execute(ctx: BackendCallContext, sessionId: string): AsyncIterable<CodingEvent> {
    if (!sessionId) {
      throw new Error(
        `ClaudeCodeBackend.execute called for task ${ctx.task.id} without a session id`,
      );
    }
    const prompt = buildExecutePrompt(ctx.repo);
    const flags = [
      ...COMMON_FLAGS,
      "--permission-mode",
      EXECUTE_PERMISSION_MODE,
      "--resume",
      sessionId,
    ];
    return runClaude(this.#binary, ctx.container, flags, prompt, "execute");
  }
}

async function* runClaude(
  binary: string,
  container: TaskContainerHandle,
  flags: readonly string[],
  prompt: string,
  mode: RunMode,
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

  // Drain stderr in the background — the CLI emits diagnostics here, and
  // an unconsumed PassThrough buffer would grow unbounded for the run
  // duration. Pipe each line to the logger at warn level (claude doesn't
  // distinguish severity on stderr; treating everything as warn surfaces
  // issues without being noisy in the success path). The try/catch
  // catches stream-error rejections from `for await` (the demuxed
  // PassThrough is destroyed when the underlying exec stream errors).
  void (async () => {
    try {
      let buf = "";
      for await (const chunk of exec.stderr) {
        buf += chunk.toString();
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) log.warn({ stderr: line.trim() }, "claude stderr");
          nl = buf.indexOf("\n");
        }
      }
      if (buf.trim()) log.warn({ stderr: buf.trim() }, "claude stderr");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "claude stderr drain error");
    }
  })();

  let textBuf = "";
  let usage: BackendUsage | undefined;
  let resultIsError = false;
  let sessionEmitted = false;
  // Tool-use blocks are surfaced from the consolidated `assistant` message
  // (which arrives once Claude finishes that turn) rather than from
  // stream_event content_block_start frames — by the time the consolidated
  // message lands, `input` is fully assembled, whereas partial-message
  // frames stream input_json_delta fragments we'd have to reassemble.
  // `seenToolUseIds` dedupes against the same tool_use being echoed in a
  // later `result.message` payload (Anthropic occasionally repeats blocks).
  // Plus a tool_use_id → name map: tool_result blocks only carry
  // tool_use_id (Anthropic's stream-json schema doesn't repeat the name
  // on the result), so we resolve the human-readable name from the prior
  // tool_use block when emitting the `tool_result` event.
  const seenToolUseIds = new Set<string>();
  const seenToolResultIds = new Set<string>();
  const toolUseNames = new Map<string, string>();

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
        // Only accumulate in plan mode — the buffer is read by the
        // result event to emit `plan_ready`. Execute-mode narration can
        // run for tens of minutes and produce megabytes of text; keeping
        // the whole buffer in memory until completion is wasteful when
        // we never look at it.
        if (mode === "plan") textBuf += delta.text;
        yield { kind: "text_delta", text: delta.text };
      }
      continue;
    }

    if (event.type === "assistant") {
      for (const raw of event.message?.content ?? []) {
        const block = ToolUseBlockSchema.safeParse(raw);
        if (!block.success) continue;
        // Always record the id→name mapping so a delayed tool_use block
        // can still resolve. seenToolUseIds gates the user-visible
        // `tool_call` emit (no duplicate calls); the name map persists
        // either way.
        toolUseNames.set(block.data.id, block.data.name);
        if (seenToolUseIds.has(block.data.id)) continue;
        seenToolUseIds.add(block.data.id);
        yield { kind: "tool_call", tool: block.data.name, input: block.data.input };
      }
      continue;
    }

    if (event.type === "user") {
      for (const raw of event.message?.content ?? []) {
        const block = ToolResultBlockSchema.safeParse(raw);
        if (!block.success) continue;
        if (seenToolResultIds.has(block.data.tool_use_id)) continue;
        seenToolResultIds.add(block.data.tool_use_id);
        // Resolve the human-readable name from the prior tool_use block.
        // Fall back to the opaque id if we somehow saw the result before
        // its corresponding tool_use (shouldn't happen — Anthropic emits
        // them in order — but cheap defensive fallback).
        const toolName = toolUseNames.get(block.data.tool_use_id) ?? block.data.tool_use_id;
        yield {
          kind: "tool_result",
          tool: toolName,
          ok: block.data.is_error !== true,
          ...(typeof block.data.content === "string" && { summary: block.data.content }),
        };
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
      // Plan mode: `--include-partial-messages` already streamed every text
      // delta; the accumulated buffer IS the plan. Execute mode: text deltas
      // are progress narration, not a structured artifact, so we don't emit
      // plan_ready (the orchestrator persists the diff out-of-band).
      if (mode === "plan" && !resultIsError && textBuf.length > 0) {
        yield { kind: "plan_ready", plan: textBuf };
      }
    }
  }

  const { exitCode } = await exec.wait();
  yield {
    kind: "complete",
    exitCode,
    isError: resultIsError || exitCode !== 0,
    ...(usage && { usage }),
  };
}
