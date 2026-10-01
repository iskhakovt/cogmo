import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import { IDENTITY_BLOCK_KEY } from "../../agent/core-memory/scope.js";
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
        const keys = await agentStore.listCoreMemoryKeys(tx, identity.userId, name);
        if (keys.length > 0 && !confirm) {
          // In use first, since that call deletes nothing; the FK stays the
          // authority at delete time.
          const refs = (await agentStore.listProfiles(tx, identity.userId)).filter(
            (p) => p.userId === identity.userId && p.profileClass === name,
          ).length;
          if (refs > 0) return err({ code: "profile_class_in_use" as const, profileRefs: refs });
          return err({ code: "profile_class_has_blocks" as const, keys: [...keys] });
        }
        const result = await agentStore.deleteProfileClass(tx, identity.userId, name);
        if (result.isErr()) {
          return err({
            code: "profile_class_in_use" as const,
            profileRefs: result.error.profileRefs,
          });
        }
        if (!result.value.deleted) {
          return err({ code: "profile_class_not_found" as const, name });
        }
        return ok(undefined);
      });
    },

    async setRestricted(platformUserHandle, name, restricted, { confirm }) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const override =
          !restricted &&
          (await agentStore.listCoreMemoryKeys(tx, identity.userId, name)).includes(
            IDENTITY_BLOCK_KEY,
          );
        if (override && !confirm) {
          return err({ code: "profile_class_has_blocks" as const, keys: [IDENTITY_BLOCK_KEY] });
        }
        const result = await agentStore.setProfileClassRestricted(
          tx,
          identity.userId,
          name,
          restricted,
        );
        if (!result.updated) {
          return err({ code: "profile_class_not_found" as const, name });
        }
        if (override) {
          await agentStore.deleteCoreMemoryBlock(tx, {
            userId: identity.userId,
            profileClass: name,
            key: IDENTITY_BLOCK_KEY,
          });
        }
        return ok({ overrideDeleted: override });
      });
    },
  };
}
