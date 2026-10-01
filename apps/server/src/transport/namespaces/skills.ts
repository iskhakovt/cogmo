import { err, ok, type Result } from "neverthrow";
import { match } from "ts-pattern";
import type { SkillDeployOrigin, SkillRunner } from "../../skills/runner.js";
import type { SkillRiskTier, SkillStore, SkillTier } from "../../skills/store/index.js";
import type { TransportError } from "../transport-error.js";
import type { TransportContext } from "./context.js";

/**
 * One row of `skills.list` — the operator-facing projection. Carries the
 * full `gitSha` so adapters can render it however they like (Telegram
 * shortens to 7 chars; a CLI might print the full sha).
 */
export interface SkillListEntry {
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  disabled: boolean;
  gitSha: string;
}

/**
 * Skills-deploy approval surface for the approve-tier inline keyboard.
 * Mirrors the `coding` namespace shape: identity-checked, calls into the
 * existing `SkillRunner` RPCs, returns `Result` with skills-specific
 * error codes. Returns `skills_disabled` when the skills module isn't
 * wired (skipped in some test setups).
 */
export interface SkillsNamespace {
  /**
   * Approve a pending-approval deploy by its `skill_deploys.id`. Calls
   * `runner.approveDeploy` which advances main + flips the row live.
   * Idempotent on already-resolved deploys via the underlying store
   * method. The tapper is the approver; the conversation in
   * `platformAddress`, the chat the tap came from, is the approval's
   * origin.
   */
  approveDeploy(
    pendingId: string,
    tapperPlatformHandle: string,
    platformAddress: string,
  ): Promise<Result<{ pendingId: string; skillName: string; gitSha: string }, TransportError>>;
  /**
   * Deny a pending-approval deploy. Resolves the row to `denied`; the
   * skills row stays at its existing state (live skill stays live, never-
   * activated skill stays disabled). Idempotent.
   */
  denyDeploy(
    pendingId: string,
    tapperPlatformHandle: string,
    reason?: string,
  ): Promise<Result<{ pendingId: string }, TransportError>>;
  /**
   * List all skills (enabled + disabled), sorted by name. Operator surface
   * for `/skills` in Telegram and the equivalent CLI list. Returns
   * `skills_disabled` when the runtime isn't wired.
   */
  list(platformUserHandle: string): Promise<Result<ReadonlyArray<SkillListEntry>, TransportError>>;
  /**
   * Soft-disable a live skill by name. Wraps `runner.deregister` —
   * preserves history, just flips `disabled=true`. Returns
   * `skill_not_found` when the name is unknown.
   */
  disable(
    platformUserHandle: string,
    name: string,
  ): Promise<Result<{ name: string }, TransportError>>;
  /**
   * Re-enable a previously-disabled skill. Refuses with
   * `skill_no_live_deploy` if the skill was never live at its current
   * `gitSha` (denied-on-first-deploy guard — see {@link SkillRunner.enable}).
   * Idempotent on already-enabled rows. Like an approval, the caller and
   * the conversation in `platformAddress` are the origin a schedule it
   * puts live runs as; `schedule` is that schedule, when there is one.
   */
  enable(
    platformUserHandle: string,
    name: string,
    platformAddress: string,
  ): Promise<Result<{ name: string; alreadyEnabled: boolean; schedule?: string }, TransportError>>;
}

export function createSkills(
  deps: TransportContext & {
    skillRunner: SkillRunner | undefined;
    skillStore: SkillStore | undefined;
  },
): SkillsNamespace {
  const { channelId, runInTx, transportStore, agentStore, skillRunner, skillStore } = deps;
  return {
    async approveDeploy(pendingId, tapperPlatformHandle, platformAddress) {
      if (!skillRunner || !skillStore) return err({ code: "skills_disabled" as const });
      const origin = await resolveSkillsActor(tapperPlatformHandle, platformAddress);
      if (!origin) return err({ code: "identity_rejected" as const });

      // Pre-check the deploy's status so we can return a precise error
      // code when it's already resolved (avoids the `runner.approveDeploy
      // → "rejected"` → string-parsing dance). Race window: the deploy
      // could resolve between this read and the actual approve call;
      // that's fine — runner.approveDeploy is itself atomic and the
      // worst case is we return "live" when the user expected
      // already-resolved.
      const deploy = await runInTx((tx) => skillStore.getDeployById(tx, pendingId));
      if (!deploy) return err({ code: "skill_deploy_not_found" as const, pendingId });
      if (deploy.status !== "pending_approval") {
        return err({
          code: "skill_deploy_not_pending" as const,
          pendingId,
          status: deploy.status,
        });
      }

      const result = await skillRunner.approveDeploy({ pendingId, origin });
      if (result.status === "live") {
        return ok({
          pendingId,
          skillName: result.name,
          gitSha: result.gitSha,
        });
      }
      // Runner rejected — surface the runner's reason verbatim so the
      // Telegram callback handler can show a useful toast.
      return err({
        code: "skill_deploy_register_failed" as const,
        pendingId,
        reason: result.errors?.[0] ?? `unexpected status '${result.status}'`,
      });
    },
    async denyDeploy(pendingId, tapperPlatformHandle, reason) {
      if (!skillRunner || !skillStore) return err({ code: "skills_disabled" as const });
      const identityCheck = await checkSkillsTapper(tapperPlatformHandle);
      if (identityCheck.isErr()) return err(identityCheck.error);

      const deploy = await runInTx((tx) => skillStore.getDeployById(tx, pendingId));
      if (!deploy) return err({ code: "skill_deploy_not_found" as const, pendingId });
      // denyDeploy is idempotent on already-resolved deploys (the store
      // method skips the update + returns silently). We still surface a
      // distinct error code for clarity at this layer — a tap on an
      // already-denied keyboard should toast "already resolved", not
      // "denied successfully".
      if (deploy.status !== "pending_approval") {
        return err({
          code: "skill_deploy_not_pending" as const,
          pendingId,
          status: deploy.status,
        });
      }
      await skillRunner.denyDeploy({
        pendingId,
        ...(reason !== undefined && { reason }),
      });
      return ok({ pendingId });
    },

    async list(platformUserHandle) {
      const identityCheck = await checkSkillsTapper(platformUserHandle);
      if (identityCheck.isErr()) return err(identityCheck.error);
      if (!skillRunner) return err({ code: "skills_disabled" as const });
      const rows = await skillRunner.listAll();
      return ok(
        rows.map((r) => ({
          name: r.name,
          tier: r.tier,
          riskTier: r.riskTier,
          disabled: r.disabled,
          gitSha: r.gitSha,
        })),
      );
    },

    async disable(platformUserHandle, name) {
      const identityCheck = await checkSkillsTapper(platformUserHandle);
      if (identityCheck.isErr()) return err(identityCheck.error);
      if (!skillRunner) return err({ code: "skills_disabled" as const });
      const result = await skillRunner.deregister({ name });
      return match(result)
        .returnType<Result<{ name: string }, TransportError>>()
        .with({ kind: "deregistered" }, (r) => ok({ name: r.name }))
        .with({ kind: "rejected", reason: "not_found" }, (r) =>
          err({ code: "skill_not_found", name: r.name }),
        )
        .exhaustive();
    },

    async enable(platformUserHandle, name, platformAddress) {
      const origin = await resolveSkillsActor(platformUserHandle, platformAddress);
      if (!origin) return err({ code: "identity_rejected" as const });
      if (!skillRunner) return err({ code: "skills_disabled" as const });
      const result = await skillRunner.enable({ name, origin });
      return match(result)
        .returnType<
          Result<{ name: string; alreadyEnabled: boolean; schedule?: string }, TransportError>
        >()
        .with({ kind: "enabled" }, (r) =>
          ok({
            name: r.name,
            alreadyEnabled: false,
            ...(r.schedule !== null && { schedule: r.schedule }),
          }),
        )
        .with({ kind: "already_enabled" }, (r) => ok({ name: r.name, alreadyEnabled: true }))
        .with({ kind: "rejected", reason: "not_found" }, (r) =>
          err({ code: "skill_not_found", name: r.name }),
        )
        .with({ kind: "rejected", reason: "no_live_deploy" }, (r) =>
          err({ code: "skill_no_live_deploy", name: r.name }),
        )
        .exhaustive();
    },
  };

  /**
   * The origin of a skills action a user takes in a chat (an approval, an
   * enable): their identity row, and the conversation the chat's active
   * session points at. Undefined when the handle is not a known user.
   */
  async function resolveSkillsActor(
    platformUserHandle: string,
    platformAddress: string,
  ): Promise<Extract<SkillDeployOrigin, { kind: "user" }> | undefined> {
    return runInTx(async (tx) => {
      const actor = await transportStore.resolveIdentity(tx, channelId, platformUserHandle);
      if (!actor) return undefined;
      const session = await transportStore.resolveSession(tx, channelId, platformAddress);
      const conv = session
        ? await agentStore.getConversation(tx, session.conversationId)
        : undefined;
      return {
        kind: "user" as const,
        actor,
        conversation: conv ? { userId: conv.userId, profileId: conv.profileId } : null,
      };
    });
  }

  /**
   * Identity check for the rest of the skills admin surface (deny, list,
   * disable). Skills are deployment-wide, so the check is "is the tapper a
   * known user of this channel". `resolveUser` returns
   * non-null iff the platform handle is allowlisted; that's the same gate
   * the inbound message path already enforces.
   *
   * Caveat (same as checkTaskOwnership): single-user wildcard mode resolves
   * any handle to the same userId, so this degenerates to "channel is
   * known". Acceptable at personal scale; multi-user deployments get the
   * stricter handle→userId mapping for free.
   */
  async function checkSkillsTapper(
    tapperPlatformHandle: string,
  ): Promise<Result<void, TransportError>> {
    const tapper = await runInTx((tx) =>
      transportStore.resolveUser(tx, channelId, tapperPlatformHandle),
    );
    if (!tapper) {
      return err({ code: "identity_rejected" as const });
    }
    return ok(undefined);
  }
}
