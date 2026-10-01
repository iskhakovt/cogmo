import { err, ok, type Result } from "neverthrow";
import type { Transaction } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";

/** Why a profile-class delete changed nothing. */
export type DeleteProfileClassRefusal =
  | { kind: "in_use"; profileRefs: number }
  | { kind: "has_blocks"; keys: string[] }
  | { kind: "not_found" };

/**
 * Delete one of the user's profile classes, and with it the core-memory
 * blocks scoped to the class. Deleting blocks needs `confirm`: without it, a
 * class that has blocks is refused with their keys and nothing changes. A
 * class still assigned to a profile is refused first, since that delete
 * would change nothing either; the FK stays the authority at delete time.
 *
 * Runs in the caller's transaction so the caller's identity check and the
 * delete see one snapshot.
 */
export async function deleteProfileClass(
  tx: Transaction,
  agentStore: Pick<AgentStore, "listCoreMemoryKeys" | "listProfiles" | "deleteProfileClass">,
  args: { userId: string; name: string; confirm: boolean },
): Promise<Result<void, DeleteProfileClassRefusal>> {
  const { userId, name, confirm } = args;
  const keys = await agentStore.listCoreMemoryKeys(tx, userId, name);
  if (keys.length > 0 && !confirm) {
    const refs = (await agentStore.listProfiles(tx, userId)).filter(
      (p) => p.userId === userId && p.profileClass === name,
    ).length;
    if (refs > 0) return err({ kind: "in_use", profileRefs: refs });
    return err({ kind: "has_blocks", keys: [...keys] });
  }
  const result = await agentStore.deleteProfileClass(tx, userId, name);
  if (result.isErr()) return err({ kind: "in_use", profileRefs: result.error.profileRefs });
  if (!result.value.deleted) return err({ kind: "not_found" });
  return ok(undefined);
}
