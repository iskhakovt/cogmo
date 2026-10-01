import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { CustomCompartment } from "../../agent/store/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * Custom compartments — per-user extensions of the curated `MemoryCompartment`
 * enum. The Observer loads these on each fire and templates `description`
 * into the classifier prompt; descriptions are LLM-facing instructions, not
 * documentation. Forward-only delete: `delete` removes future
 * classifications but does not touch `compartment:<name>` tags already
 * stamped on Hindsight memories. Cap is `CUSTOM_COMPARTMENT_LIMIT`.
 */
export interface CompartmentsNamespace {
  list(
    platformUserHandle: string,
  ): Promise<Result<ReadonlyArray<CustomCompartment>, TransportError>>;
  create(
    platformUserHandle: string,
    input: { name: string; description: string },
  ): Promise<Result<CustomCompartment, TransportError>>;
  delete(platformUserHandle: string, name: string): Promise<Result<void, TransportError>>;
}

export function createCompartments(deps: TransportContext): CompartmentsNamespace {
  const { channelId, runInTx, transportStore, agentStore } = deps;
  return {
    async list(platformUserHandle) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        return ok(await agentStore.listCustomCompartments(tx, identity.userId));
      });
    },

    async create(platformUserHandle, input) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const created = await agentStore.createCustomCompartment(tx, {
          userId: identity.userId,
          name: input.name,
          description: input.description,
        });
        return created.mapErr((e) =>
          match(e)
            .returnType<TransportError>()
            .with({ kind: "invalid_name" }, ({ name }) => ({
              code: "compartment_name_invalid",
              name,
            }))
            .with({ kind: "compartment_name_reserved" }, ({ name }) => ({
              code: "compartment_name_reserved",
              name,
            }))
            .with({ kind: "compartment_cap_exceeded" }, ({ limit, current }) => ({
              code: "compartment_cap_exceeded",
              limit,
              current,
            }))
            .with({ kind: "compartment_name_taken" }, ({ name }) => ({
              code: "compartment_name_taken",
              name,
            }))
            .exhaustive(),
        );
      });
    },

    async delete(platformUserHandle, name) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const result = await agentStore.deleteCustomCompartment(tx, identity.userId, name);
        if (!result.deleted) {
          return err({ code: "compartment_not_found" as const, name });
        }
        return ok(undefined);
      });
    },
  };
}
