import { compileToolMatchers } from "../agent/tool-matchers.js";
import { ToolRegistry, type ToolSpec } from "../agent/tools.js";
import { logger } from "../logger.js";
import type { SkillRunner, SkillToolDef } from "./runner.js";

const log = logger.child({ component: "skills.tool-builder" });

/**
 * Convert a registered skill into a per-turn LLM tool. The tool's name + JSON
 * Schema come from the manifest; the handler calls `runner.invoke` and
 * returns the JSON-stringified output (or error).
 *
 * One tool per skill — matches the progressive-disclosure design (see
 * `design/skills.md` → Invocation). The orchestrator rebuilds the tool list
 * each turn so skills registered between turns appear immediately and
 * disabled/rolled-back skills disappear; this builder is the per-skill
 * conversion step.
 */
export function buildSkillToolSpec(def: SkillToolDef, runner: SkillRunner): ToolSpec {
  return {
    name: def.name,
    description: def.description,
    // Durable: a skill run executes arbitrary Python with side effects
    // (network writes via ctx, memory staging) and, for tier-2, spins up a
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
    handler: async (input) => {
      const result = await runner.invoke({
        name: def.name,
        inputs: input,
        trigger: "manual",
      });
      if (result.status === "error") {
        // Surface errors as tool_result text (the loop wraps thrown errors
        // as isError tool_results too — symmetric, but we already have the
        // structured result so prefer the explicit JSON shape).
        return JSON.stringify({
          ok: false,
          error: result.error ?? "unknown_error",
          runId: result.runId,
        });
      }
      return JSON.stringify({
        ok: true,
        runId: result.runId,
        output: result.output ?? null,
      });
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
export async function buildSkillTools(runner: SkillRunner): Promise<readonly ToolSpec[]> {
  try {
    const defs = await runner.listToolDefs();
    return defs.map((d) => buildSkillToolSpec(d, runner));
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
