/**
 * Deterministic validation pass over a compiled pipeline definition.
 *
 * Runs after Zod structural validation (`PipelineDefinitionSchema.parse`)
 * and enforces the cross-field rules a schema can't express: kind/field
 * consistency, loop-scope disjointness, tool-glob resolution, trigger
 * viability. Issues carry a `path` + `message` so the compiler's feedback
 * retry can hand them back to the LLM verbatim.
 */

import { Ajv } from "ajv";
import picomatch from "picomatch";
import { validateCron } from "../scheduling/cron.js";
import { MAX_DURATION_MS, type PipelineDefinition, parseDurationMs } from "./types.js";

export interface ValidationIssue {
  /** Dot path into the definition, e.g. "stages[2].loop.backTo". */
  path: string;
  message: string;
}

export interface ValidationContext {
  /** Tool names registered for the turn — stage tool globs must match at least one. */
  availableTools: ReadonlyArray<string>;
  /**
   * Event names external sources publish on the bus. Empty until slice 4b
   * lands the first source — event triggers and wait stages fail validation
   * with a clear message until then.
   */
  knownEventSources: ReadonlyArray<string>;
}

// One process-wide Ajv for meta-schema checks. `strict: false` matches the
// skills runner's instance — compiler-emitted schemas routinely carry
// harmless annotations (title, examples) that strict mode rejects.
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Validate a structurally-valid definition against the deterministic rules.
 * Returns all issues found (never throws on bad input) — an empty array
 * means the definition is activatable.
 */
export function validateDefinition(
  definition: PipelineDefinition,
  ctx: ValidationContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  validateTrigger(definition, ctx, issues);

  const stageIndexById = new Map<string, number>();
  definition.stages.forEach((stage, i) => {
    if (stageIndexById.has(stage.id)) {
      issues.push({
        path: `stages[${i}].id`,
        message: `duplicate stage id "${stage.id}" — stage ids must be unique`,
      });
    }
    stageIndexById.set(stage.id, i);
  });

  definition.stages.forEach((stage, i) => {
    const at = (field: string) => `stages[${i}].${field}`;

    // Kind/field consistency — the union of optional fields is constrained
    // per kind so a gate config on an agentic stage can't silently no-op.
    if (stage.kind === "gate" && stage.gate === undefined) {
      issues.push({
        path: at("gate"),
        message: `gate stage "${stage.id}" must carry a gate config`,
      });
    }
    if (stage.kind !== "gate" && stage.gate !== undefined) {
      issues.push({
        path: at("gate"),
        message: `stage "${stage.id}" is ${stage.kind} — gate config only belongs on gate stages`,
      });
    }
    if (stage.kind === "wait" && stage.wait === undefined) {
      issues.push({
        path: at("wait"),
        message: `wait stage "${stage.id}" must carry a wait config`,
      });
    }
    if (stage.kind !== "wait" && stage.wait !== undefined) {
      issues.push({
        path: at("wait"),
        message: `stage "${stage.id}" is ${stage.kind} — wait config only belongs on wait stages`,
      });
    }
    if ((stage.kind === "agentic" || stage.kind === "gate") && stage.instructions === undefined) {
      issues.push({
        path: at("instructions"),
        message: `${stage.kind} stage "${stage.id}" needs instructions — that's the prose the agent interprets`,
      });
    }
    if (stage.kind !== "agentic" && stage.tools !== undefined) {
      issues.push({
        path: at("tools"),
        message: `stage "${stage.id}" is ${stage.kind} — tool allowlists only belong on agentic stages`,
      });
    }
    if (stage.kind !== "agentic" && stage.output !== undefined) {
      issues.push({
        path: at("output"),
        message: `stage "${stage.id}" is ${stage.kind} — typed outputs only belong on agentic stages`,
      });
    }

    if (stage.tools !== undefined) {
      for (const glob of stage.tools) {
        if (!ctx.availableTools.some((name) => picomatch.isMatch(name, glob))) {
          issues.push({
            path: at("tools"),
            message: `tool glob "${glob}" matches no registered tool. Available: ${[...ctx.availableTools].sort().join(", ")}`,
          });
        }
      }
    }

    if (stage.output?.kind === "json" && !ajv.validateSchema(stage.output.schema)) {
      const detail = ajv.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
      issues.push({
        path: at("output.schema"),
        message: `not a valid JSON Schema: ${detail ?? "unknown error"}`,
      });
    }

    if (stage.wait !== undefined && !ctx.knownEventSources.includes(stage.wait.event)) {
      issues.push({
        path: at("wait.event"),
        message: noEventSourceMessage(stage.wait.event, ctx),
      });
    }

    for (const [field, checkpoint] of [
      ["gate", stage.gate],
      ["wait", stage.wait],
    ] as const) {
      if (checkpoint === undefined) continue;
      const ms = parseDurationMs(checkpoint.timeout);
      if (ms === 0) {
        issues.push({
          path: at(`${field}.timeout`),
          message: `"${checkpoint.timeout}" is a zero-duration timeout — it would fire instantly`,
        });
      }
      // The ceiling bounds the checkpoint's TOTAL effective park: remind
      // re-arms the deadline, so the worst case is timeout × (maxReminders
      // + 1) before the terminal action (design/pipelines.md → schema).
      const arms =
        checkpoint.onTimeout.kind === "remind" ? checkpoint.onTimeout.maxReminders + 1 : 1;
      if (ms * arms > MAX_DURATION_MS) {
        issues.push({
          path: at(`${field}.timeout`),
          message:
            arms === 1
              ? `"${checkpoint.timeout}" exceeds the 1-year park ceiling`
              : `"${checkpoint.timeout}" × ${arms} arms (timeout × (maxReminders + 1)) exceeds the 1-year park ceiling`,
        });
      }
    }
  });

  validateLoops(definition, stageIndexById, issues);

  return issues;
}

function validateTrigger(
  definition: PipelineDefinition,
  ctx: ValidationContext,
  issues: ValidationIssue[],
): void {
  const { trigger } = definition;
  if (trigger.kind === "cron") {
    const result = validateCron(trigger.schedule, trigger.timezone);
    if (result.isErr()) {
      issues.push({
        path: "trigger.schedule",
        message: `invalid cron: ${JSON.stringify(result.error)}`,
      });
    }
  }
  if (trigger.kind === "event" && !ctx.knownEventSources.includes(trigger.source)) {
    issues.push({ path: "trigger.source", message: noEventSourceMessage(trigger.source, ctx) });
  }
}

function noEventSourceMessage(source: string, ctx: ValidationContext): string {
  return ctx.knownEventSources.length === 0
    ? `no external event sources are registered yet — "${source}" cannot fire. Use a command or cron trigger instead, and an agentic/gate stage in place of the wait`
    : `unknown event source "${source}". Known: ${[...ctx.knownEventSources].sort().join(", ")}`;
}

/**
 * Loop back-edges must reference a strictly earlier stage, and loop scopes
 * `[backTo..stage]` must be pairwise disjoint — no nesting, no crossing.
 * Flat scopes are what makes the single `iteration` counter on a run sound
 * (design/pipelines.md → Loops).
 */
function validateLoops(
  definition: PipelineDefinition,
  stageIndexById: Map<string, number>,
  issues: ValidationIssue[],
): void {
  const scopes: Array<{ start: number; end: number; stageId: string }> = [];

  definition.stages.forEach((stage, i) => {
    if (stage.loop === undefined) return;
    const target = stageIndexById.get(stage.loop.backTo);
    if (target === undefined) {
      issues.push({
        path: `stages[${i}].loop.backTo`,
        message: `"${stage.loop.backTo}" is not a stage id`,
      });
      return;
    }
    if (target >= i) {
      issues.push({
        path: `stages[${i}].loop.backTo`,
        message: `"${stage.loop.backTo}" must be an earlier stage — back-edges only point backwards`,
      });
      return;
    }
    scopes.push({ start: target, end: i, stageId: stage.id });
  });

  for (let a = 0; a < scopes.length; a++) {
    for (let b = a + 1; b < scopes.length; b++) {
      const first = scopes[a];
      const second = scopes[b];
      if (first === undefined || second === undefined) continue;
      const disjoint = first.end < second.start || second.end < first.start;
      if (!disjoint) {
        issues.push({
          // `end` IS the looping stage's index — exact even when duplicate
          // stage ids (flagged separately) make an id lookup ambiguous.
          path: `stages[${second.end}].loop`,
          message: `loop scope of "${second.stageId}" overlaps the loop scope of "${first.stageId}" — loop scopes must be disjoint (no nesting or crossing)`,
        });
      }
    }
  }
}
