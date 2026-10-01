import type { Transaction } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";
import { isCoreCompartment } from "./memory-extraction-schema.js";

/**
 * Return the first of `compartments` that is neither a core compartment nor
 * one of the user's registered `custom_compartments`, or `null` when every
 * value is valid. Validates a profile's memory scope before it is written;
 * runs in the caller's transaction so the check and the write see one
 * snapshot.
 */
export async function findUnknownCompartment(
  tx: Transaction,
  agentStore: Pick<AgentStore, "listCustomCompartments">,
  userId: string,
  compartments: ReadonlyArray<string>,
): Promise<string | null> {
  const customs = await agentStore.listCustomCompartments(tx, userId);
  const customNames = new Set(customs.map((c) => c.name));
  return compartments.find((c) => !isCoreCompartment(c) && !customNames.has(c)) ?? null;
}
