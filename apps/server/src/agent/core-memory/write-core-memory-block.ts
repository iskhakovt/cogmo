import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import type { Transaction, Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";
import { type CoreMemoryScope, IDENTITY_BLOCK_KEY } from "./scope.js";

/**
 * Where a core-memory write lands: the shared `identity`, the unclassed
 * bucket, the turn's class, or a restricted class's `identity` override.
 */
type CoreMemoryWriteTarget =
  | { kind: "shared" }
  | { kind: "unclassed" }
  | { kind: "class"; profileClass: string }
  | { kind: "override"; profileClass: string };

/**
 * What a core-memory write stored. An override leaves out the lines the
 * shared `identity` holds (`leftOut`, whitespace-normalised, each once); when
 * only blank lines remain, it stores nothing and the class has no override.
 */
export type CoreMemoryWrite =
  | Exclude<CoreMemoryWriteTarget, { kind: "override" }>
  | { kind: "override"; profileClass: string; leftOut: ReadonlyArray<string> }
  | { kind: "override-matches-shared"; profileClass: string };

export interface CoreMemoryUnavailable {
  code: "core_memory_unavailable";
}

type CoreMemoryWriteStore = Pick<
  AgentStore,
  "getCoreMemoryBlocks" | "upsertCoreMemoryBlock" | "deleteCoreMemoryBlock"
>;

/**
 * Write one block where the turn's scope sends it (design/memory.md →
 * Behaviour by Profile). The model never picks the scope: `identity` is
 * shared unless the class is restricted, when it becomes the class's
 * override, and every other key stays in the class or the unclassed bucket.
 * A turn with no core memory writes nothing.
 */
export async function writeCoreMemoryBlock(
  deps: { runInTx: Transactor; agentStore: CoreMemoryWriteStore },
  args: { userId: string; scope: CoreMemoryScope; key: string; content: string },
): Promise<Result<CoreMemoryWrite, CoreMemoryUnavailable>> {
  const target = resolveTarget(args.scope, args.key);
  if (target === null) return err({ code: "core_memory_unavailable" });
  if (target.kind === "override") {
    const { profileClass } = target;
    return ok(
      await deps.runInTx((tx) => writeOverride(tx, deps.agentStore, { ...args, profileClass })),
    );
  }
  await deps.runInTx((tx) =>
    deps.agentStore.upsertCoreMemoryBlock(tx, {
      userId: args.userId,
      profileClass: target.kind === "class" ? target.profileClass : null,
      key: args.key,
      content: args.content,
    }),
  );
  return ok(target);
}

/**
 * Store a restricted class's `identity` override without the lines the
 * shared block holds, so the persona keeps following shared changes to them.
 * A retried tool step re-reads the shared block, so it stores the same
 * content unless that block changed in between.
 */
async function writeOverride(
  tx: Transaction,
  store: CoreMemoryWriteStore,
  args: { userId: string; profileClass: string; content: string },
): Promise<CoreMemoryWrite> {
  const { userId, profileClass } = args;
  const shared = (await store.getCoreMemoryBlocks(tx, userId, profileClass)).find(
    (b) => b.profileClass === null && b.key === IDENTITY_BLOCK_KEY,
  );
  const { content, leftOut } = withoutSharedLines(args.content, shared?.content ?? "");
  const block = { userId, profileClass, key: IDENTITY_BLOCK_KEY };
  if (content === null) {
    await store.deleteCoreMemoryBlock(tx, block);
    return { kind: "override-matches-shared", profileClass };
  }
  await store.upsertCoreMemoryBlock(tx, { ...block, content });
  return { kind: "override", profileClass, leftOut };
}

/**
 * `override` without its lines equal to one of `shared`'s, compared trimmed
 * and with internal whitespace collapsed, and without blank lines at either
 * end; null when only blank lines remain. A blank line never counts as shared.
 */
function withoutSharedLines(
  override: string,
  shared: string,
): { content: string | null; leftOut: string[] } {
  const sharedLines = new Set(shared.split("\n").map(normalizeLine).filter(Boolean));
  const lines = override.split("\n");
  const isShared = (line: string) => sharedLines.has(normalizeLine(line));
  const kept = lines.filter((line) => !isShared(line));
  const first = kept.findIndex((line) => line.trim() !== "");
  const last = kept.findLastIndex((line) => line.trim() !== "");
  return {
    content: first === -1 ? null : kept.slice(first, last + 1).join("\n"),
    leftOut: R.unique(lines.filter(isShared).map(normalizeLine)),
  };
}

/** A line as the override dedupe compares it: trimmed, internal whitespace collapsed. */
export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
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
