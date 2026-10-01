/**
 * Inngest handler for `skills/cron.fire`. Resolves the skill row, no-ops if
 * the skill was disabled, deregistered or unscheduled between tick and fire,
 * and otherwise invokes it via {@link SkillRunner} as the row's run-as
 * identity.
 *
 * Parallel to `src/agent/scheduling/fire-handler.ts`. Same per-row
 * `concurrency: { limit: 1, key: "event.data.skillId" }` posture: if the
 * ticker's event-bus dedup misses, the function-level cap keeps two fires
 * for the same skill from racing inside the runner pool.
 *
 * Cron-fired invocations pass an empty inputs object — `manifest.inputs`
 * must therefore have no `required` fields (or have defaults) for a
 * cron-scheduled skill. A manifest that requires inputs and is also
 * scheduled is a deploy-time foot-gun that surfaces here as a
 * `skipped: invalid_inputs` result instead of an Inngest retry storm.
 */

import type { Inngest } from "inngest";
import { match } from "ts-pattern";
import type { Transactor } from "../db/index.js";
import { skillCronFire } from "../inngest/events.js";
import { logger } from "../logger.js";
import { describeInvokeRejection, type SkillInvokeRejection } from "./invoke-rejection.js";
import type { SkillRunAs } from "./run-as.js";
import type { SkillRunner } from "./runner.js";
import type { SkillRunIdentity, SkillStore } from "./store/index.js";

const log = logger.child({ component: "skills.cron-fire-handler" });

export interface SkillCronFireDeps {
  runner: SkillRunner;
  runInTx: Transactor;
  store: Pick<SkillStore, "getSkillById">;
  /** The scoped services for a stored identity (`resolveSkillRunAs`). */
  resolveRunAs(identity: SkillRunIdentity): Promise<SkillRunAs>;
}

type SkipReason =
  | "skill_not_found"
  | "not_scheduled"
  | "skill_disabled"
  | "invalid_inputs"
  | "sandbox_unavailable"
  | "inflight";

type DispatchResult =
  | { status: "completed"; runId: string; runStatus: "success" | "error" }
  | { status: "skipped"; reason: SkipReason; detail?: string };

/** The skip a runner rejection becomes. Retries can't repair any of them. */
function skipReason(rejection: SkillInvokeRejection): SkipReason {
  return match(rejection.kind)
    .returnType<SkipReason>()
    .with("not_found", () => "skill_not_found")
    .with("disabled", () => "skill_disabled")
    .with("invalid_inputs", () => "invalid_inputs")
    .with("sandbox_unavailable", () => "sandbox_unavailable")
    .with("inflight", () => "inflight")
    .exhaustive();
}

export function createSkillCronFireHandler(deps: SkillCronFireDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "skill-cron-fire",
      retries: 2,
      concurrency: { limit: 1, key: "event.data.skillId" },
      triggers: [skillCronFire],
    },
    async ({ event, step }) => {
      const { skillId, skillName, scheduledFor } = event.data;

      // Deterministic-per-fire idempotency key — same shape as the
      // event-bus dedup id. A retry that crosses the bus-dedup window
      // (rare but possible) lands in `runner.invoke` with the same key,
      // and the recovery_point state machine takes over: cached terminal
      // result → return without touching runtime; executed but not
      // finished → finalize-only; in-flight (crash OR concurrent worker)
      // → an `inflight` rejection, skipped below so the operator can
      // investigate.
      const idempotencyKey = `skill-cron:${skillId}:${scheduledFor}`;

      const result = await step.run("dispatch", async (): Promise<DispatchResult> => {
        // Who the fire runs as is read here, inside the step, so a replay
        // takes it from the memoized result rather than a fresh read.
        const skill = await deps.runInTx((tx) => deps.store.getSkillById(tx, skillId));
        if (!skill) {
          return { status: "skipped", reason: "skill_not_found" };
        }
        // A disabled row runs as no one, so this precedes the run-as check.
        if (skill.disabled) {
          return { status: "skipped", reason: "skill_disabled" };
        }
        // Checks both columns to narrow their types; on an enabled row the
        // CHECK makes this the same as `schedule === null`, i.e. a deploy
        // dropped the schedule after the tick locked the row.
        if (skill.runAsUserId === null || skill.runAsProfileId === null) {
          return { status: "skipped", reason: "not_scheduled" };
        }
        const runAs = await deps.resolveRunAs({
          userId: skill.runAsUserId,
          profileId: skill.runAsProfileId,
        });
        // A thrown error (sandbox transient, DB blip) propagates so Inngest's
        // `retries: 2` budget applies. The retry reuses the idempotency key:
        // a run that got past execute replays or finalizes, and one that
        // died mid-execute is skipped as `inflight` rather than run twice.
        const invoked = await deps.runner.invoke({
          name: skillName,
          inputs: {},
          trigger: "cron",
          idempotencyKey,
          runAs,
        });
        return invoked.match(
          (run): DispatchResult => ({
            status: "completed",
            runId: run.runId,
            runStatus: run.status,
          }),
          (rejection): DispatchResult => ({
            status: "skipped",
            reason: skipReason(rejection),
            detail: describeInvokeRejection(rejection),
          }),
        );
      });

      if (result.status === "skipped") {
        log.warn(
          { skillId, skillName, scheduledFor, reason: result.reason, detail: result.detail },
          "skill cron fire skipped",
        );
        return result;
      }

      log.info(
        {
          skillId,
          skillName,
          scheduledFor,
          runId: result.runId,
          runStatus: result.runStatus,
        },
        "skill cron fire dispatched",
      );
      return result;
    },
  );
}
