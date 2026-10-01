import { err, ok, type Result } from "neverthrow";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * Per-chat preferences keyed on `(channelId, platformAddress)`. Today the
 * only surface is the default profile used for new conversations on the
 * chat — `createConversation` consults this before falling back to the
 * global default. Identity-checked: the caller must resolve to a user on
 * the channel; the bound profile must be visible to that user (org or
 * their own).
 */
export interface ChatsNamespace {
  /** Return the chat's pinned default profile, or `null` when unset. */
  getDefaultProfile(
    platformUserHandle: string,
    platformAddress: string,
  ): Promise<Result<{ profileId: string; profileName: string } | null, TransportError>>;
  /** Pin a profile as the chat's default. Upsert — overwrites any prior binding. */
  setDefaultProfile(
    platformUserHandle: string,
    platformAddress: string,
    profileId: string,
  ): Promise<Result<void, TransportError>>;
  /** Remove the chat's default-profile binding. Idempotent. */
  clearDefaultProfile(
    platformUserHandle: string,
    platformAddress: string,
  ): Promise<Result<void, TransportError>>;
}

export function createChats(deps: TransportContext): ChatsNamespace {
  const { channelId, runInTx, transportStore, agentStore } = deps;
  return {
    async getDefaultProfile(platformUserHandle, platformAddress) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const row = await transportStore.getChatDefaultProfile(tx, channelId, platformAddress);
        if (!row) return ok(null);
        const profile = await agentStore.getProfile(tx, row.profileId);
        // The FK ON DELETE CASCADE on profile_id sweeps the binding when
        // the profile is deleted, so seeing a row here without a profile
        // would mean the cascade missed — treat as a real invariant break
        // rather than masking it.
        if (!profile) return err({ code: "profile_not_found" as const });
        return ok({ profileId: row.profileId, profileName: profile.name });
      });
    },

    async setDefaultProfile(platformUserHandle, platformAddress, profileId) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const owner = await agentStore.getProfileOwner(tx, profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId !== null && owner.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "profile not visible to caller",
          });
        }
        await transportStore.setChatDefaultProfile(tx, {
          channelId,
          platformAddress,
          profileId,
        });
        return ok(undefined);
      });
    },

    async clearDefaultProfile(platformUserHandle, platformAddress) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        await transportStore.clearChatDefaultProfile(tx, channelId, platformAddress);
        return ok(undefined);
      });
    },
  };
}
