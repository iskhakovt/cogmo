/**
 * The execute phase's `execute-cli` stage: resume the plan's CLI session
 * with edits allowed, streamed to the user, and record what it cost.
 */

import type { SandboxSession } from "../../sandbox/index.js";
import type { BackendUsage, CodingBackend } from "./backend.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import type { ExecuteStreamHandle } from "./progress-stream.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

interface ExecuteSessionResult {
  isError: boolean;
  failureReason?: string;
  usage?: BackendUsage;
}

/**
 * Durable: a billable session, and `isError` selects disjoint step sets
 * downstream. The `started` banner and the token/tool pushes fire live from
 * inside the body and are suppressed on replay — one run's worth of
 * progress, which is what the UI wants.
 */
export async function runExecuteSession(
  run: CodingRun,
  deps: { backend: CodingBackend },
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    sessionId: string;
    container: () => Promise<SandboxSession>;
    stream: ExecuteStreamHandle;
  },
): Promise<ExecuteSessionResult> {
  return run.stepRun("execute-cli", async () => {
    await args.stream.started();
    return streamExecute(deps.backend, {
      task: args.task,
      repo: args.repo,
      container: await args.container(),
      stream: args.stream,
      sessionId: args.sessionId,
    });
  });
}

/**
 * The `persist-usage` step: the backend's camelCase usage translated into
 * the snake_case `resource_usage` schema. Skipped when nothing was reported.
 */
export async function persistSessionUsage(
  run: CodingRun,
  deps: TaskStoreDeps,
  usage: BackendUsage | undefined,
): Promise<void> {
  if (!usage) return;
  const row: Record<string, number> = {};
  if (usage.inputTokens != null) row.tokens_input = usage.inputTokens;
  if (usage.outputTokens != null) row.tokens_output = usage.outputTokens;
  if (usage.costUsd != null) row.cost_usd = usage.costUsd;
  if (Object.keys(row).length === 0) return;
  await run.stepRun("persist-usage", () =>
    deps.runInTx((tx) => deps.store.setTaskResourceUsage(tx, run.taskId, row)),
  );
}

/** Token counts for the completion banner, when the backend reported both. */
export function completionTokens(
  usage: BackendUsage | undefined,
): { input: number; output: number } | undefined {
  return usage?.inputTokens != null && usage?.outputTokens != null
    ? { input: usage.inputTokens, output: usage.outputTokens }
    : undefined;
}

async function streamExecute(
  backend: CodingBackend,
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    container: SandboxSession;
    stream: ExecuteStreamHandle;
    sessionId: string;
  },
): Promise<ExecuteSessionResult> {
  const { task, repo, container, stream, sessionId } = args;
  let isError = false;
  let failureReason: string | undefined;
  let usage: BackendUsage | undefined;

  for await (const event of backend.execute({ task, repo, container }, sessionId)) {
    switch (event.kind) {
      case "session_started":
        // The resumed session — the plan phase's persisted id stays
        // authoritative, so it is not re-written.
        break;
      case "text_delta":
        await stream.appendText(event.text);
        break;
      case "tool_call":
        await stream.toolCall(event.tool);
        break;
      case "tool_result":
        await stream.toolResult(event.tool, event.ok, event.summary);
        break;
      case "complete":
        if (event.usage) usage = event.usage;
        if (event.isError) {
          isError = true;
          failureReason = `claude exit code ${event.exitCode}`;
        }
        break;
    }
  }

  return {
    isError,
    ...(failureReason !== undefined && { failureReason }),
    ...(usage && { usage }),
  };
}
