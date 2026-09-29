import { err, ok, type Result } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import type { Transaction, Transactor } from "../../db/index.js";
import { coreMemoryEdits } from "../../metrics.js";
import type { AgentStore, CoreMemoryUpsertOutcome } from "../store/index.js";
import { type CoreMemoryScope, DOCUMENTED_BLOCK_KEYS, IDENTITY_BLOCK_KEY } from "./scope.js";

type CoreMemoryWriteTarget =
  | { kind: "shared" }
  | { kind: "unclassed" }
  | { kind: "class"; profileClass: string }
  | { kind: "override"; profileClass: string };

/**
 * What a write stored, for the tool result. `leftOut` lists an override's
 * lines the shared `identity` holds, normalised, each once;
 * `override-matches-shared` means no line differed, so the class has no
 * override.
 */
export type CoreMemoryWrite =
  | Exclude<CoreMemoryWriteTarget, { kind: "override" }>
  | { kind: "override"; profileClass: string; leftOut: ReadonlyArray<string> }
  | { kind: "override-matches-shared"; profileClass: string };

export interface CoreMemoryUnavailable {
  code: "core_memory_unavailable";
}

/** A write's effect on the stored block. */
type BlockChange = CoreMemoryUpsertOutcome | "deleted";

/** Keys the edit counter records as themselves; any other is `other`. */
const LABELLED_KEYS: ReadonlySet<string> = new Set(DOCUMENTED_BLOCK_KEYS);

type CoreMemoryWriteStore = Pick<
  AgentStore,
  "getCoreMemoryBlocks" | "upsertCoreMemoryBlock" | "deleteCoreMemoryBlock"
>;

/** Write one block where the turn's scope sends it (design/memory.md → Behaviour by Profile). */
export async function writeCoreMemoryBlock(
  deps: { runInTx: Transactor; agentStore: CoreMemoryWriteStore },
  args: { userId: string; scope: CoreMemoryScope; key: string; content: string },
): Promise<Result<CoreMemoryWrite, CoreMemoryUnavailable>> {
  const target = resolveTarget(args.scope, args.key);
  if (target === null) return err({ code: "core_memory_unavailable" });
  if (target.kind === "override") {
    const { profileClass } = target;
    const { write, change } = await deps.runInTx((tx) =>
      writeOverride(tx, deps.agentStore, { ...args, profileClass }),
    );
    countEdit(args.key, target, change);
    return ok(write);
  }
  const upserted = await deps.runInTx((tx) =>
    deps.agentStore.upsertCoreMemoryBlock(tx, {
      userId: args.userId,
      profileClass: target.kind === "class" ? target.profileClass : null,
      key: args.key,
      content: args.content,
    }),
  );
  countEdit(args.key, target, upserted);
  return ok(target);
}

/**
 * Count a committed change in `cogmo.core_memory.edits`. The key is free text
 * the model picks, so an undocumented one is labelled `other`, keeping content
 * out of the label and its cardinality bounded.
 */
function countEdit(key: string, target: CoreMemoryWriteTarget, change: BlockChange): void {
  if (change === "unchanged") return;
  coreMemoryEdits.add(1, {
    key: LABELLED_KEYS.has(key) ? key : "other",
    target: target.kind,
    change,
  });
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
): Promise<{ write: CoreMemoryWrite; change: BlockChange }> {
  const { userId, profileClass } = args;
  const shared = (await store.getCoreMemoryBlocks(tx, userId, profileClass)).find(
    (b) => b.profileClass === null && b.key === IDENTITY_BLOCK_KEY,
  );
  const { content, leftOut } = withoutSharedLines(args.content, shared?.content ?? "");
  const block = { userId, profileClass, key: IDENTITY_BLOCK_KEY };
  if (content === null) {
    const deleted = await store.deleteCoreMemoryBlock(tx, block);
    return {
      write: { kind: "override-matches-shared", profileClass },
      change: deleted ? "deleted" : "unchanged",
    };
  }
  return {
    write: { kind: "override", profileClass, leftOut },
    change: await store.upsertCoreMemoryBlock(tx, { ...block, content }),
  };
}

/**
 * `override` without the lines `shared` holds (by `normalizeLine`) or its
 * blank edge lines; null when only blank lines remain. A blank line never
 * counts as shared.
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
