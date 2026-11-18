/**
 * The execute phase's `execute-cli` stage: resume the plan's CLI session
 * with edits allowed, or start a fix pass's fresh one, streamed to the user,
 * and record what it cost.
 */

import { match } from "ts-pattern";
import type { SandboxSession } from "../../sandbox/index.js";
import type { BackendUsage, CodingBackend, CodingEvent } from "./backend.js";
import type { CodingRun, TaskStoreDeps } from "./coding-run.js";
import { loadFixContext } from "./fix-pass.js";
import type { ExecuteStreamHandle } from "./progress-stream.js";
import { fromSessionResult, type SessionResult } from "./session-result.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";
import type { SessionUsage, TaskFailure } from "./types.js";

/**
 * What an execute run's session is: the plan's, resumed once the plan gate
 * cleared, or a fresh one for the skills repo's fix pass `fixPass`.
 */
export type ExecuteSession =
  | { kind: "resume"; sessionId: string }
  | { kind: "fix"; fixPass: number };

/** The pass an execute run hands to verify: 0 for the approved plan's run. */
export function fixPassOf(session: ExecuteSession): number {
  return match(session)
    .with({ kind: "resume" }, () => 0)
    .with({ kind: "fix" }, ({ fixPass }) => fixPass)
    .exhaustive();
}

/**
 * Durable: a billable session, and its `kind` selects disjoint step sets
 * downstream. The `started` banner and the token/tool pushes fire live from
 * inside the body and are suppressed on replay — one run's worth of
 * progress, which is what the UI wants. A fix session's prompt is built
 * from the row here, inside the body.
 */
export async function runExecuteSession(
  run: CodingRun,
  deps: TaskStoreDeps & { backend: CodingBackend },
  args: {
    task: CodingTaskRow;
    repo: CodingRepoRow;
    session: ExecuteSession;
    container: () => Promise<SandboxSession>;
    stream: ExecuteStreamHandle;
  },
): Promise<SessionResult> {
  const { repo, stream } = args;
  const memo = await run.stepRun("execute-cli", async () => {
    await stream.started();
    const container = await args.container();
    const events = await match(args.session)
      .with({ kind: "resume" }, async ({ sessionId }) =>
        deps.backend.execute({ task: args.task, repo, container }, sessionId),
      )
      .with({ kind: "fix" }, async () => {
        const { task, fix } = await loadFixContext(deps, run.taskId, repo);
        return deps.backend.fix({ task, repo, container }, fix);
      })
      .exhaustive();
    return streamExecute(events, stream);
  });
  return fromSessionResult(memo);
}

/**
 * The `persist-usage` step: the backend's camelCase usage translated into
 * the snake_case `resource_usage` schema. A fix pass adds its usage to the
 * task's; the approved plan's run sets it. Skipped when nothing was reported.
 */
export async function persistSessionUsage(
  run: CodingRun,
  deps: TaskStoreDeps,
  usage: BackendUsage | undefined,
  session: ExecuteSession,
): Promise<void> {
  if (!usage) return;
  const row: SessionUsage = {
    ...(usage.inputTokens != null && { tokens_input: usage.inputTokens }),
    ...(usage.outputTokens != null && { tokens_output: usage.outputTokens }),
    ...(usage.costUsd != null && { cost_usd: usage.costUsd }),
  };
  if (Object.keys(row).length === 0) return;
  await run.stepRun("persist-usage", () =>
    deps.runInTx((tx) =>
      match(session)
        .with({ kind: "resume" }, () => deps.store.setTaskResourceUsage(tx, run.taskId, row))
        .with({ kind: "fix" }, async ({ fixPass }) => {
          // A re-run after a lost result finds the pass counted and adds nothing.
          await deps.store.addTaskResourceUsage(tx, run.taskId, row, fixPass);
        })
        .exhaustive(),
    ),
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
  events: AsyncIterable<CodingEvent>,
  stream: ExecuteStreamHandle,
): Promise<SessionResult> {
  let failure: TaskFailure | undefined;
  let usage: BackendUsage | undefined;

  for await (const event of events) {
    await match(event)
      // The plan phase's persisted id stays authoritative, so neither a
      // resumed nor a fix session's id is written.
      .with({ kind: "session_started" }, () => undefined)
      .with({ kind: "text_delta" }, (e) => stream.appendText(e.text))
      .with({ kind: "tool_call" }, (e) => stream.toolCall(e.tool))
      .with({ kind: "tool_result" }, (e) => stream.toolResult(e.tool, e.ok, e.summary))
      .with({ kind: "complete" }, (e) => {
        if (e.usage) usage = e.usage;
        if (e.isError) {
          failure = { reason: "cli_exit_error", detail: `claude exit code ${e.exitCode}` };
        }
      })
      // Execute mode never presents a plan; a stray `plan_ready` carries nothing to stream.
      .with({ kind: "plan_ready" }, () => undefined)
      .exhaustive();
  }

  if (failure) return { kind: "errored", failure };
  return { kind: "completed", ...(usage && { usage }) };
}
