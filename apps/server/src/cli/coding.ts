/**
 * `cogmo coding <command>` — the owner's actions on coding tasks. See
 * design/coding-delegation.md → Task lifecycle.
 */

import { command, positional, subcommands } from "cmd-ts";
import { match } from "ts-pattern";
import {
  type CancelCodingTaskDeps,
  type CancelCodingTaskError,
  cancelCodingTask,
} from "../agent/coding/cancel-coding-task.js";
import { uuid } from "./args.js";
import type { CliIo, LoadDeps } from "./run.js";

export type CodingCliDeps = CancelCodingTaskDeps;

export function codingCli(io: CliIo, loadDeps: LoadDeps<CodingCliDeps>) {
  return subcommands({
    name: "coding",
    description: "Act on coding tasks.",
    cmds: {
      cancel: command({
        name: "cancel",
        description:
          "Cancel a task that has not ended, freeing its repo's slot. A run working on it stops at its next status change.",
        args: {
          taskId: positional({
            type: uuid("task-id"),
            displayName: "task-id",
            description: "The task's id.",
          }),
        },
        handler: async (args) => cancel(args, await loadDeps(), io),
      }),
    },
  });
}

async function cancel(args: { taskId: string }, deps: CodingCliDeps, io: CliIo): Promise<number> {
  const { taskId } = args;
  const cancelled = await cancelCodingTask(deps, { taskId, reason: "user_cancelled" });
  if (cancelled.isErr()) {
    io.err(describeCancelError(cancelled.error, taskId));
    return 1;
  }
  io.out(`Cancelled coding task ${taskId}.`);
  return 0;
}

function describeCancelError(e: CancelCodingTaskError, taskId: string): string {
  return match(e)
    .with(
      { kind: "already_terminal" },
      ({ status }) => `Coding task ${taskId} has already ended: ${status}.`,
    )
    .with({ kind: "not_found" }, () => `No coding task ${taskId}.`)
    .exhaustive();
}
