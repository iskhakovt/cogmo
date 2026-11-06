import { ok } from "neverthrow";
import { match, P } from "ts-pattern";
import { compileToolMatchers } from "../agent/tool-matchers.js";
import { reject, ToolRegistry, type ToolRejection, type ToolSpec } from "../agent/tools.js";
import { logger } from "../logger.js";
import { truncate } from "../util/string.js";
import { skillRunErrorClass } from "./invoke/run-result.js";
import { describeInvokeRejection, type SkillInvokeRejection } from "./invoke-rejection.js";
import type { SkillRunner, SkillRunResult, SkillToolDef } from "./runner.js";
import { summarizeWasmPackagesError } from "./worker-wasm/wasm.js";

const log = logger.child({ component: "skills.tool-builder" });

/**
 * The runner's conservative in-flight refusal, as a rejection the model can act on.
 *
 * An `inflight` rejection means a prior attempt under this idempotency key left
 * its `skill_runs` row at `recovery_point='started'` — the runner can't tell
 * a crashed attempt from a concurrently-executing one, so it declines rather
 * than re-firing the skill's side effects. Naming it lets the model surface an
 * honest verdict instead of an opaque failure. The `started` marker is written
 * *before* execution, so how far the earlier attempt got is genuinely unknown
 * — the message says so rather than claiming partial completion. Reason
 * string matches `skill-cron-fire`'s `"inflight"`.
 */
function inflightRejection(name: string, runId: string): ToolRejection {
  log.warn({ skillName: name, runId }, "skill tool invocation refused — prior run still in flight");
  return {
    message:
      `A previous attempt at this exact call (run ${runId}) is recorded as still running, ` +
      `so ${name} was not started again. Whether it did any work is unknown — the row is ` +
      "marked in-flight before execution begins, so the earlier attempt may have done " +
      "everything, nothing, or stopped partway. Do not silently re-run it: tell the user what " +
      "was attempted and ask them to check the result before deciding.",
  };
}

/**
 * A runner rejection as the model reads it. A wasm package failure names
 * only its kind and package: its detail carries host paths, which the
 * invocation logs at warn.
 */
function toolRejection(name: string, rejection: SkillInvokeRejection): ToolRejection {
  return match(rejection)
    .returnType<ToolRejection>()
    .with({ kind: "inflight" }, ({ runId }) => inflightRejection(name, runId))
    .with({ kind: "wasm_packages_unavailable" }, ({ error }) => ({
      message: `skill '${name}' cannot run: wasm packages unavailable: ${summarizeWasmPackagesError(error)}`,
    }))
    .with(
      { kind: P.union("not_found", "disabled", "invalid_inputs", "sandbox_unavailable") },
      (r) => ({ message: describeInvokeRejection(r) }),
    )
    .exhaustive();
}

/**
 * A failed run as the model reads it, by what its error means: an
 * `output_invalid` run acted and returned the kept output, a `lost` one may
 * have acted, a `pausing` one may succeed later.
 */
function runFailureMessage(
  name: string,
  run: Extract<SkillRunResult, { status: "error" }>,
): string {
  return match(run)
    .returnType<string>()
    .with({ errorKind: "output_invalid" }, ({ runId, error, output }) => {
      const returned = output === undefined ? "" : ` It returned: ${quotedOutput(output)}`;
      return `skill ${name} ran, but its output failed validation (run ${runId}): ${error}. Its effects happened.${returned}`;
    })
    .with({ errorKind: P.not("output_invalid") }, ({ runId, error, errorKind }) =>
      match(skillRunErrorClass(errorKind))
        .returnType<string>()
        .with(
          "lost",
          () =>
            `skill ${name} lost its result (run ${runId}, ${errorKind}): ${error}. It may have done everything, nothing, or stopped partway. Do not run it again on your own: tell the user what was attempted and ask them to check the result before deciding.`,
        )
        .with(
          "pausing",
          () =>
            `skill ${name} hit a temporary failure (run ${runId}, ${errorKind}): ${error}. A later attempt may succeed.`,
        )
        .with(
          P.union("defect", "expected", "legacy"),
          () => `skill ${name} failed (run ${runId}, ${errorKind}): ${error}`,
        )
        .exhaustive(),
    )
    .exhaustive();
}

/** How much of an `output_invalid` run's output the model is shown. */
const QUOTED_OUTPUT_CHARS = 2000;

/** The output a schema refused, as JSON, cut to {@link QUOTED_OUTPUT_CHARS}. */
function quotedOutput(output: unknown): string {
  return truncate(JSON.stringify(output), QUOTED_OUTPUT_CHARS);
}

/** The turn a skill tool is built for: the conversation's user and profile, whom a run acts for. */
export interface SkillToolTurn {
  userId: string;
  profileId: string;
}

/**
 * Convert a registered skill into a per-turn LLM tool. The tool's name + JSON
 * Schema come from the manifest; the handler calls `runner.invoke` as the
 * turn's user, through the turn's scoped `Service`, and returns the
 * JSON-stringified output, or rejects with the run's error.
 *
 * One tool per skill — matches the progressive-disclosure design (see
 * `design/skills.md` → Invocation). The orchestrator rebuilds the tool list
 * each turn so skills registered between turns appear immediately and
 * disabled/rolled-back skills disappear; this builder is the per-skill
 * conversion step.
 */
export function buildSkillToolSpec(
  def: SkillToolDef,
  runner: SkillRunner,
  turn: SkillToolTurn,
): ToolSpec {
  return {
    name: def.name,
    description: def.description,
    // Durable: a skill run executes arbitrary Python with side effects
    // (network writes via ctx, Hindsight retains) and, for a container skill, spins up a
    // sandbox. Non-durable it would re-invoke once per remaining step
    // boundary of the turn. The cached value is the JSON-stringified
    // output the model saw — exactly-once execution AND a stable persisted
    // tool_result.
    durable: true,
    // `SkillInputs` is structurally `JsonSchema` — both pin `type: "object"`
    // (literal) + optional `properties`/`required` + a permissive index
    // signature. SkillManifestSchema enforces this at register time, so the
    // assignment needs no cast.
    inputSchema: def.inputs,
    handler: async (input, service, ctx) => {
      // A run refused as in flight reaches the model as a rejection naming
      // the run, the verdict `skill-cron-fire` gives it.
      const invoked = await runner.invoke({
        name: def.name,
        inputs: input,
        trigger: "manual",
        runAs: { userId: turn.userId, profileId: turn.profileId, service },
        // Durability covers replay; the key covers the crash between the
        // skill's side effects committing and Inngest recording the step
        // result. `runner.invoke` routes it to the `recovery_point` state
        // machine, which replays or finalizes instead of re-executing.
        ...(ctx !== undefined && { idempotencyKey: `skill-tool:${ctx.idempotencyKey}` }),
      });
      return invoked
        .mapErr((rejection) => toolRejection(def.name, rejection))
        .andThen((run) =>
          run.status === "error"
            ? reject(runFailureMessage(def.name, run))
            : ok(JSON.stringify({ ok: true, runId: run.runId, output: run.output ?? null })),
        );
    },
  };
}

/**
 * Build the full set of skill tools for one turn. Tolerant: per-skill failure
 * (manifest unreadable from git, etc.) is logged and dropped; the rest of the
 * tool list still loads. The runner's `listToolDefs` already does the
 * skip-on-error work for source loading; this wrapper exists so the
 * orchestrator can call one method and get back ToolSpecs ready to register.
 */
export async function buildSkillTools(
  runner: SkillRunner,
  turn: SkillToolTurn,
): Promise<readonly ToolSpec[]> {
  try {
    const defs = await runner.listToolDefs();
    return defs.map((d) => buildSkillToolSpec(d, runner, turn));
  } catch (e) {
    log.warn({ err: e }, "skill tool list build failed — proceeding with built-in tools only");
    return [];
  }
}

/**
 * Compose the per-turn `ToolRegistry`: built-ins win on any name collision
 * with a skill. A skill that happens to share a name with a built-in tool
 * (`web_search`, `delegate_coding`, `register_skill`, etc.) is dropped with a
 * warning instead of silently overwriting the built-in handler — that path
 * would let a skill author ship arbitrary code under a built-in's identity,
 * which the LLM trusts.
 *
 * Returns the new registry. Source registries are not mutated.
 */
export function mergeBuiltInsAndSkillTools(
  builtIns: ReadonlyArray<ToolSpec>,
  skillTools: ReadonlyArray<ToolSpec>,
): ToolRegistry {
  const merged = new ToolRegistry();
  const builtInNames = new Set<string>();
  for (const spec of builtIns) {
    merged.register(spec);
    builtInNames.add(spec.name);
  }
  for (const spec of skillTools) {
    if (builtInNames.has(spec.name)) {
      log.warn(
        { skillName: spec.name },
        "skipping skill — name collides with a built-in tool; built-in wins",
      );
      continue;
    }
    merged.register(spec);
  }
  return merged;
}

/**
 * Compose the per-turn `ToolRegistry` from all three tool sources (built-ins,
 * skills, MCP) gated by the active profile's `toolSet` globs.
 *
 * Filtering: each source is filtered through `compileToolMatchers(toolSetGlobs)`
 * before composition. An empty `toolSetGlobs` means **no tools** for the turn
 * (matches the schema's "empty array = chat-only profile" semantic). The
 * default seeded org profile uses `["*"]` to opt every tool back in — that
 * preserves the historical "all tools surface" behaviour for users who haven't
 * customised their profile.
 *
 * Collision rule: built-ins win over skills (rug-pull defense — an evolved
 * skill must not silently shadow a trusted built-in). MCP tools carry the
 * `mcp__<server>__<tool>` prefix and structurally cannot collide with either,
 * but the check is in place as defense in depth.
 *
 * Returns a fresh registry — source arrays are never mutated.
 */
export function composeTurnTools(opts: {
  builtIns: ReadonlyArray<ToolSpec>;
  skillTools: ReadonlyArray<ToolSpec>;
  mcpTools: ReadonlyArray<ToolSpec>;
  toolSetGlobs: readonly string[];
}): ToolRegistry {
  const matcher = compileToolMatchers(opts.toolSetGlobs);

  const filteredBuiltIns = opts.builtIns.filter((t) => matcher(t.name));
  const filteredSkills = opts.skillTools.filter((t) => matcher(t.name));
  const filteredMcp = opts.mcpTools.filter((t) => matcher(t.name));

  const merged = mergeBuiltInsAndSkillTools(filteredBuiltIns, filteredSkills);
  for (const spec of filteredMcp) {
    if (merged.get(spec.name)) {
      log.warn(
        { mcpToolName: spec.name },
        "skipping MCP tool — name collides with built-in or skill",
      );
      continue;
    }
    merged.register(spec);
  }
  return merged;
}
