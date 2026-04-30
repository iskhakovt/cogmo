import type { ToolSpec } from "../agent/tools.js";
import type { JsonSchema } from "../llm/types.js";
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
    inputSchema: def.inputs as unknown as JsonSchema,
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
