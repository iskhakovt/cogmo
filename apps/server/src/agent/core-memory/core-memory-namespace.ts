import type { Transactor } from "../../db/index.js";
import type { Service } from "../service.js";
import type { AgentStore } from "../store/index.js";
import { type CoreMemoryScope, readCoreMemory } from "./scope.js";
import { writeCoreMemoryBlock } from "./write-core-memory-block.js";

/**
 * The `coreMemory` namespace of one turn's Service: reads and writes of the
 * conversation user's blocks, confined to the turn's frozen scope.
 */
export function createCoreMemoryNamespace(
  deps: {
    runInTx: Transactor;
    agentStore: Pick<AgentStore, "getCoreMemoryBlocks" | "upsertCoreMemoryBlock">;
  },
  args: { userId: string; scope: CoreMemoryScope },
): Service["coreMemory"] {
  return {
    get: () => deps.runInTx((tx) => readCoreMemory(tx, deps.agentStore, args.userId, args.scope)),
    update: (key, content) => writeCoreMemoryBlock(deps, { ...args, key, content }),
  };
}
