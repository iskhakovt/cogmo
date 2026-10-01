import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { deleteProfileClass } from "../../agent/core-memory/delete-profile-class.js";
import { setProfileClassRestricted } from "../../agent/core-memory/set-profile-class-restricted.js";
import type { ProfileClass } from "../../agent/store/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * Profile-class registry — the user-owned label set used by the
 * speaker-isolation tag axis. Each class is `(name, description)` per
 * user; profiles assign themselves to a class via `profiles.setClass`.
 * Org-level classes are not currently supported.
 */
export interface ProfileClassesNamespace {
  list(platformUserHandle: string): Promise<Result<ReadonlyArray<ProfileClass>, TransportError>>;
  create(
    platformUserHandle: string,
    input: { name: string; description: string },
  ): Promise<Result<ProfileClass, TransportError>>;
  /**
   * Delete a class, and with it the class's core-memory blocks. A call
   * that would delete blocks without `confirm` returns
   * `profile_class_has_blocks` with their keys and changes nothing;
   * `profile_class_in_use` comes first, since that call deletes nothing.
   */
  delete(
    platformUserHandle: string,
    name: string,
    opts: { confirm: boolean },
  ): Promise<Result<void, TransportError>>;
  /**
   * Flip the `restricted` flag on a class. Independent of whether any
   * profile currently references the class — marking restricted while
   * in use is the common case (a class becoming sensitive after the
   * fact). `profile_class_not_found` when no row matches the name.
   * Unrestricting deletes the class's `identity` override in the same
   * transaction, so no unrestricted class shadows the shared block, and
   * reports whether there was one; without `confirm`, a call that would
   * delete it returns `profile_class_has_blocks` and changes nothing.
   */
  setRestricted(
    platformUserHandle: string,
    name: string,
    restricted: boolean,
    opts: { confirm: boolean },
  ): Promise<Result<{ overrideDeleted: boolean }, TransportError>>;
}

export function createProfileClasses(deps: TransportContext): ProfileClassesNamespace {
  const { channelId, runInTx, transportStore, agentStore } = deps;
  return {
    async list(platformUserHandle) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        return ok(await agentStore.listProfileClasses(tx, identity.userId));
      });
    },

    async create(platformUserHandle, input) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const created = await agentStore.createProfileClass(tx, {
          userId: identity.userId,
          name: input.name,
          description: input.description,
        });
        return created.mapErr((e) =>
          match(e)
            .returnType<TransportError>()
            .with({ kind: "invalid_name" }, ({ name }) => ({
              code: "profile_class_name_invalid",
              name,
            }))
            .with({ kind: "profile_class_name_taken" }, ({ name }) => ({
              code: "profile_class_name_taken",
              name,
            }))
            .exhaustive(),
        );
      });
    },

    async delete(platformUserHandle, name, { confirm }) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const deleted = await deleteProfileClass(tx, agentStore, {
          userId: identity.userId,
          name,
          confirm,
        });
        return deleted.mapErr((refusal) =>
          match(refusal)
            .returnType<TransportError>()
            .with({ kind: "in_use" }, ({ profileRefs }) => ({
              code: "profile_class_in_use",
              profileRefs,
            }))
            .with({ kind: "has_blocks" }, ({ keys }) => ({
              code: "profile_class_has_blocks",
              keys,
            }))
            .with({ kind: "not_found" }, () => ({ code: "profile_class_not_found", name }))
            .exhaustive(),
        );
      });
    },

    async setRestricted(platformUserHandle, name, restricted, { confirm }) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const set = await setProfileClassRestricted(tx, agentStore, {
          userId: identity.userId,
          name,
          restricted,
          confirm,
        });
        return set.mapErr((refusal) =>
          match(refusal)
            .returnType<TransportError>()
            .with({ kind: "has_blocks" }, ({ keys }) => ({
              code: "profile_class_has_blocks",
              keys,
            }))
            .with({ kind: "not_found" }, () => ({ code: "profile_class_not_found", name }))
            .exhaustive(),
        );
      });
    },
  };
}
