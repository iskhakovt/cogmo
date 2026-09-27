import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";
import { type CoreMemoryScope, IDENTITY_BLOCK_KEY } from "./scope.js";

/**
 * Where a core-memory write lands: the shared `identity`, the unclassed
 * bucket, the turn's class, or a restricted class's `identity` override.
 */
export type CoreMemoryWriteTarget =
  | { kind: "shared" }
  | { kind: "unclassed" }
  | { kind: "class"; profileClass: string }
  | { kind: "override"; profileClass: string };

export interface CoreMemoryUnavailable {
  code: "core_memory_unavailable";
}

/**
 * Write one block where the turn's scope sends it (design/memory.md →
 * Behaviour by Profile). The model never picks the scope: `identity` is
 * shared unless the class is restricted, when it becomes the class's
 * override, and every other key stays in the class or the unclassed bucket.
 * A turn with no core memory writes nothing.
 */
export async function writeCoreMemoryBlock(
  deps: { runInTx: Transactor; agentStore: Pick<AgentStore, "upsertCoreMemoryBlock"> },
  args: { userId: string; scope: CoreMemoryScope; key: string; content: string },
): Promise<Result<CoreMemoryWriteTarget, CoreMemoryUnavailable>> {
  const target = resolveTarget(args.scope, args.key);
  if (target === null) return err({ code: "core_memory_unavailable" });
  const profileClass =
    target.kind === "class" || target.kind === "override" ? target.profileClass : null;
  await deps.runInTx((tx) =>
    deps.agentStore.upsertCoreMemoryBlock(tx, {
      userId: args.userId,
      profileClass,
      key: args.key,
      content: args.content,
    }),
  );
  return ok(target);
}

function resolveTarget(scope: CoreMemoryScope, key: string): CoreMemoryWriteTarget | null {
  const identity = key === IDENTITY_BLOCK_KEY;
  return match(scope)
    .returnType<CoreMemoryWriteTarget | null>()
    .with({ kind: "none" }, () => null)
    .with({ kind: "unclassed" }, () => (identity ? { kind: "shared" } : { kind: "unclassed" }))
    .with({ kind: "classed" }, ({ profileClass, restricted }) => {
      if (!identity) return { kind: "class", profileClass };
      return restricted ? { kind: "override", profileClass } : { kind: "shared" };
    })
    .exhaustive();
}
