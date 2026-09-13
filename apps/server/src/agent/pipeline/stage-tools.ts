/**
 * Narrow a turn's tool registry to what one pipeline stage may use.
 *
 * The input is the registry the profile already allows (`composeTurnTools`
 * over the profile's `toolSet`), so a stage can only ever narrow it — an
 * allowlist naming a tool the profile can't see matches nothing. The pipeline
 * tools are removed unconditionally: a run must not define, activate or start
 * pipelines, which is the self-modification path the preview/confirm gate
 * exists to guard.
 */

import { compileToolMatchers } from "../tool-matchers.js";
import { ToolRegistry } from "../tools.js";
import { PIPELINE_TOOL_NAMES } from "./tools.js";

export function restrictToStage(
  profileTools: ToolRegistry,
  stageGlobs: ReadonlyArray<string> | undefined,
): ToolRegistry {
  const allowed = stageGlobs === undefined ? () => true : compileToolMatchers([...stageGlobs]);
  const registry = new ToolRegistry();
  for (const spec of profileTools.snapshot()) {
    if (!PIPELINE_TOOL_NAMES.includes(spec.name) && allowed(spec.name)) {
      registry.register(spec);
    }
  }
  return registry;
}
