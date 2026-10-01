import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import { isCoreCompartment } from "../../agent/evolution/memory-extraction-schema.js";
import type { AgentStore, CodingAutoapproveMode, Profile } from "../../agent/store/index.js";
import type { CooldownState, ProfileMemoryScope, ToolSet } from "../../agent/store/schema.js";
import type { Transaction } from "../../db/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";
import { emitCooldownClearedIfAny } from "./cooldown-cleared.js";

export interface ProfileInput {
  name: string;
  basePrompt: string;
  model: string;
  toolSet: ToolSet;
  /**
   * Memory ACL: which compartment + trust tag combinations the profile may
   * recall from Hindsight. `null` (default) = no restriction. Set via
   * `/profile scope` after creation; not part of the create dialog.
   */
  memoryScope?: ProfileMemoryScope | null;
  /**
   * Streaming-presentation knobs (Telegram today; future streaming adapters
   * if they grow). Both have schema defaults — omit to keep them. Set via
   * `/profile stream` after creation.
   */
  streamChunkChars?: number;
  streamEdits?: boolean;
  /**
   * Coding-delegation plan gate. `"on"` skips the Telegram approve/revise/
   * cancel round trip and auto-stamps `plan_approved_at` once the plan
   * text is persisted. Plan still streams to Telegram for visibility.
   * Toggled via `/profile autoapprove`. Default `"off"`.
   */
  codingAutoapproveMode?: CodingAutoapproveMode;
  // summarizationModel / extractionModel are profile-level fields in the DB but not yet exposed
  // via Transport — /profile edit doesn't cover them. Add back here when the dialog does.
}

/** Profile admin. Org profiles (user_id IS NULL) always reject mutations with `access_denied`. */
export interface ProfilesNamespace {
  list(platformUserHandle: string): Promise<Result<ReadonlyArray<Profile>, TransportError>>;
  create(platformUserHandle: string, input: ProfileInput): Promise<Result<Profile, TransportError>>;
  update(
    platformUserHandle: string,
    profileId: string,
    changes: Partial<ProfileInput>,
    /**
     * When set, clears `cooldown_state` on this conversation in the
     * same transaction as the profile update. Used by `/model` — the
     * design treats model switches as context changes that should
     * end any active cooldown; same-tx atomicity prevents a partial
     * commit from leaving "switched model but still cooling down"
     * state. Transport validates that the conversation is owned by
     * the caller AND uses this profile before applying the clear;
     * mismatch surfaces `access_denied` or `conversation_not_found`.
     *
     * See `design/agent-resilience.md` → Clear triggers.
     */
    opts?: { clearCooldownForConversation?: string },
  ): Promise<Result<Profile, TransportError>>;
  delete(platformUserHandle: string, profileId: string): Promise<Result<void, TransportError>>;
  /**
   * Set or clear `profile_class` on a non-org profile. `className: null`
   * clears it. The class must already exist in the caller's registry —
   * `unknown_profile_class` is returned otherwise.
   */
  setClass(
    platformUserHandle: string,
    profileId: string,
    className: string | null,
  ): Promise<Result<void, TransportError>>;
}

export function createProfiles(deps: TransportContext & { inngest: Inngest }): ProfilesNamespace {
  const { channelId, runInTx, transportStore, agentStore, inngest } = deps;
  return {
    async list(platformUserHandle) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        return ok(await agentStore.listProfiles(tx, identity.userId));
      });
    },

    async create(platformUserHandle, input) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!(await agentStore.isModelUserSelectable(tx, input.model))) {
          return err({ code: "model_unavailable" as const, model: input.model });
        }
        if (input.memoryScope) {
          const unknown = await findUnknownCompartmentImpl(
            tx,
            agentStore,
            identity.userId,
            input.memoryScope.compartments,
          );
          if (unknown !== null) {
            return err({ code: "compartment_unknown" as const, name: unknown });
          }
        }
        const created = await agentStore.createProfile(tx, {
          userId: identity.userId,
          name: input.name,
          basePrompt: input.basePrompt,
          model: input.model,
          toolSet: input.toolSet,
          ...(input.memoryScope !== undefined && { memoryScope: input.memoryScope }),
        });
        if (created.isErr()) return err({ code: "profile_name_taken" as const });
        return ok(created.value);
      });
    },

    async update(platformUserHandle, profileId, changes, opts) {
      // Closure-captured so the post-tx telemetry emit knows the
      // prior cooldown state. Stays `null` when no clear happened
      // (either `clearTarget` was absent or validation rejected
      // before the capture). Only read when the update succeeded.
      let priorCooldownStateForEmit: CooldownState | null = null;
      const clearTarget = opts?.clearCooldownForConversation;
      const result = await runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const owner = await agentStore.getProfileOwner(tx, profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId === null) {
          return err({
            code: "access_denied" as const,
            reason: "org profiles are read-only via Transport",
          });
        }
        if (owner.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "profile not owned by caller",
          });
        }
        if (
          changes.model !== undefined &&
          !(await agentStore.isModelUserSelectable(tx, changes.model))
        ) {
          return err({ code: "model_unavailable" as const, model: changes.model });
        }
        if (changes.memoryScope) {
          const unknown = await findUnknownCompartmentImpl(
            tx,
            agentStore,
            identity.userId,
            changes.memoryScope.compartments,
          );
          if (unknown !== null) {
            return err({ code: "compartment_unknown" as const, name: unknown });
          }
        }
        // Pre-validate the cooldown-clear side effect BEFORE the
        // profile update commits, so a wrong / missing / mismatched
        // conversation aborts the whole update rather than silently
        // dropping the clear (or worse — clearing the cooldown on a
        // conversation that doesn't use this profile, defeating the
        // "context switch ends cooldown" rationale).
        let shouldClearCooldown = false;
        if (clearTarget !== undefined) {
          const conv = await agentStore.getConversation(tx, clearTarget);
          if (!conv) return err({ code: "conversation_not_found" as const });
          if (conv.userId !== identity.userId) {
            return err({
              code: "access_denied" as const,
              reason: "conversation not owned by caller",
            });
          }
          if (conv.profileId !== profileId) {
            // The clear's rationale is "the model the failing turn
            // used changed". If the conversation doesn't actually
            // use this profile, the new model isn't its model and
            // the clear would be a spurious side effect. Reject
            // rather than silently no-op so the caller surfaces a
            // bug instead of hiding it.
            return err({
              code: "access_denied" as const,
              reason: "conversation does not use this profile",
            });
          }
          // Match setProfile's optimization — skip the UPDATE when
          // there's nothing to clear, avoiding a no-op row write.
          shouldClearCooldown = conv.cooldownState !== null;
          // Capture the prior state for the post-tx telemetry emit.
          // Stays null when there's nothing to clear, which makes
          // `emitCooldownClearedIfAny` skip below.
          priorCooldownStateForEmit = conv.cooldownState;
        }
        const updated = await agentStore.updateProfile(tx, profileId, changes);
        if (updated.isErr()) return err({ code: "profile_name_taken" as const });
        // Same-tx clear — `/model` rationale: model switch is a
        // context change that ends any active cooldown. Atomicity
        // prevents the partial-commit "switched model but still
        // cooling down" state. See
        // design/agent-resilience.md → Clear triggers.
        if (shouldClearCooldown && clearTarget !== undefined) {
          await agentStore.clearCooldown(tx, clearTarget);
        }
        return ok(updated.value);
      });
      // Emit AFTER the tx commits — an err means the clear didn't
      // happen, so don't fire telemetry.
      if (result.isOk() && clearTarget !== undefined) {
        await emitCooldownClearedIfAny(
          inngest,
          priorCooldownStateForEmit,
          clearTarget,
          "model_switch",
        );
      }
      return result;
    },

    async delete(platformUserHandle, profileId) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const owner = await agentStore.getProfileOwner(tx, profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId === null) {
          return err({
            code: "access_denied" as const,
            reason: "org profiles cannot be deleted via Transport",
          });
        }
        if (owner.userId !== identity.userId) {
          return err({ code: "access_denied" as const, reason: "profile not owned by caller" });
        }
        const deleted = await agentStore.deleteProfile(tx, profileId);
        if (deleted.isErr()) return err({ code: "profile_in_use" as const });
        return ok(undefined);
      });
    },

    async setClass(platformUserHandle, profileId, className) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const owner = await agentStore.getProfileOwner(tx, profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId === null) {
          return err({
            code: "access_denied" as const,
            reason: "org profiles cannot be classed via Transport",
          });
        }
        if (owner.userId !== identity.userId) {
          return err({ code: "access_denied" as const, reason: "profile not owned by caller" });
        }
        const set = await agentStore.setProfileClass(tx, profileId, className);
        if (set.isErr())
          return err({ code: "unknown_profile_class" as const, name: set.error.name });
        return ok(undefined);
      });
    },
  };
}

/**
 * Walk a candidate compartment list and return the first value that's
 * neither a core compartment nor one of the user's registered
 * `custom_compartments`. Returns `null` when every value is valid.
 * Loads customs via the supplied `tx` so the check sits inside the
 * outer transaction (consistency with the upcoming write).
 */
async function findUnknownCompartmentImpl(
  tx: Transaction,
  agentStore: Pick<AgentStore, "listCustomCompartments">,
  userId: string,
  compartments: ReadonlyArray<string>,
): Promise<string | null> {
  const customs = await agentStore.listCustomCompartments(tx, userId);
  const customNames = new Set(customs.map((c) => c.name));
  for (const c of compartments) {
    if (!isCoreCompartment(c) && !customNames.has(c)) return c;
  }
  return null;
}
