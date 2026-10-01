import { err, ok, type Result } from "neverthrow";
import type { Transaction } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";
import { IDENTITY_BLOCK_KEY } from "./scope.js";

/** Why a restricted-flag change changed nothing. */
export type SetProfileClassRestrictedRefusal =
  | { kind: "has_blocks"; keys: string[] }
  | { kind: "not_found" };

/**
 * Set or clear the `restricted` flag on one of the user's profile classes.
 * Only a restricted class may override the shared `identity` block, so
 * unrestricting deletes the class's override in the same transaction and
 * reports whether there was one. That delete needs `confirm`: without it, an
 * unrestrict that would delete the override is refused and nothing changes.
 *
 * Runs in the caller's transaction so the caller's identity check and the
 * write see one snapshot.
 */
export async function setProfileClassRestricted(
  tx: Transaction,
  agentStore: Pick<
    AgentStore,
    "listCoreMemoryKeys" | "setProfileClassRestricted" | "deleteCoreMemoryBlock"
  >,
  args: { userId: string; name: string; restricted: boolean; confirm: boolean },
): Promise<Result<{ overrideDeleted: boolean }, SetProfileClassRestrictedRefusal>> {
  const { userId, name, restricted, confirm } = args;
  const override =
    !restricted &&
    (await agentStore.listCoreMemoryKeys(tx, userId, name)).includes(IDENTITY_BLOCK_KEY);
  if (override && !confirm) return err({ kind: "has_blocks", keys: [IDENTITY_BLOCK_KEY] });
  const result = await agentStore.setProfileClassRestricted(tx, userId, name, restricted);
  if (!result.updated) return err({ kind: "not_found" });
  if (override) {
    await agentStore.deleteCoreMemoryBlock(tx, {
      userId,
      profileClass: name,
      key: IDENTITY_BLOCK_KEY,
    });
  }
  return ok({ overrideDeleted: override });
}
