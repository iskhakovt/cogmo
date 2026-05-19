/**
 * Inngest handler for `skills/cron.fire`. Resolves the skill row, no-ops if
 * the skill was disabled or deregistered between tick and fire, and
 * otherwise dispatches a tier-appropriate invocation via {@link SkillRunner}.
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
import { skillCronFire } from "../inngest/events.js";
import { logger } from "../logger.js";
import {
  InputValidationError,
  SandboxUnavailableError,
  SkillDisabledError,
  SkillNotFoundError,
  type SkillRunner,
} from "./runner.js";

const log = logger.child({ component: "skills.cron-fire-handler" });

export interface SkillCronFireDeps {
  runner: SkillRunner;
}

type DispatchResult =
  | { status: "completed"; runId: string; runStatus: "success" | "error" }
  | {
      status: "skipped";
      reason: "skill_not_found" | "skill_disabled" | "invalid_inputs" | "sandbox_unavailable";
      detail?: string;
    };

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

      const result = await step.run("dispatch", async (): Promise<DispatchResult> => {
        try {
          const invokeResult = await deps.runner.invoke({
            name: skillName,
            inputs: {},
            trigger: "cron",
          });
          return {
            status: "completed",
            runId: invokeResult.runId,
            runStatus: invokeResult.status,
          };
        } catch (e) {
          // `runner.invoke` throws (rather than returns Result) for the
          // pre-invocation gates: skill missing, disabled, or input
          // validation failed. Each one is a typed Error subclass so we
          // discriminate via `instanceof` — no fragile string matching
          // against `error.message`. Translate each into a non-retrying
          // skipped result; Inngest retries can't repair any of them.
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof SkillNotFoundError) {
            return { status: "skipped", reason: "skill_not_found", detail: msg };
          }
          if (e instanceof SkillDisabledError) {
            return { status: "skipped", reason: "skill_disabled", detail: msg };
          }
          if (e instanceof InputValidationError) {
            return { status: "skipped", reason: "invalid_inputs", detail: msg };
          }
          if (e instanceof SandboxUnavailableError) {
            return { status: "skipped", reason: "sandbox_unavailable", detail: msg };
          }
          // Anything else (sandbox transient, DB blip) propagates so
          // Inngest's `retries: 2` budget kicks in.
          throw e;
        }
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
