import type { TransportContext } from "./context.js";

/** Model discovery — filtered to `user_selectable = true`. */
export interface ModelsNamespace {
  list(): Promise<ReadonlyArray<string>>;
}

export function createModels(
  deps: Pick<TransportContext, "runInTx" | "agentStore">,
): ModelsNamespace {
  const { runInTx, agentStore } = deps;
  return {
    async list() {
      return runInTx((tx) => agentStore.listDistinctUserSelectableModels(tx));
    },
  };
}
