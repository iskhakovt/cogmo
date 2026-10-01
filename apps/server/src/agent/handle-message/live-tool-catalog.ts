import type { Transactor } from "../../db/index.js";
import type { LlmProviderResolver } from "../../llm/resolver.js";
import type { McpRegistry } from "../../mcp/registry.js";
import type { SkillRunner } from "../../skills/runner.js";
import { buildSkillTools, composeTurnTools } from "../../skills/skill-tool-builder.js";
import type { CoreMemoryScope } from "../core-memory/scope.js";
import { offeredBuiltIns } from "../core-memory-tools.js";
import type { ImageToolsLoader } from "../image-tools-loader.js";
import type { AgentStore } from "../store/index.js";
import { buildSubAgentTools } from "../subagent/sub-agent-tool-builder.js";
import type { ToolRegistry } from "../tools.js";

export interface LiveToolCatalogDeps {
  runInTx: Transactor;
  agentStore: Pick<AgentStore, "listSubAgents">;
  resolveProvider: LlmProviderResolver;
  tools: ToolRegistry;
  imageToolsLoader?: ImageToolsLoader;
  skillRunner?: SkillRunner;
  mcpRegistry?: McpRegistry;
}

export interface LiveToolCatalogArgs {
  userId: string;
  coreMemoryScope: CoreMemoryScope;
  /** The profile's `toolSet` globs; empty offers every tool. */
  toolSetGlobs: readonly string[];
}

/**
 * The live tool catalog — built-ins from bootstrap + the live image catalog
 * (loaded fresh each turn so wizard / CLI CRUD takes effect without a restart)
 * + one dynamic tool per live skill + MCP tools resolved against the profile's
 * globs. Rebuilt every turn so registered skills + newly-approved MCP tools
 * appear immediately, and rolled-back / disabled / un-approved ones disappear.
 * The skill-tool builder is fault-tolerant: a single skill with unreadable git
 * source is logged and dropped, the rest of the list still loads. Composition
 * policy (built-ins win on collision; profile.toolSet globs filter every
 * source) lives in `composeTurnTools`. Image tools join the built-ins set
 * rather than the skill/MCP sets — they're first-party and should win on any
 * name collision with operator-installed extensions, same as memory / web /
 * file tools.
 *
 * Every invocation builds it, for the handlers; which tools the turn offers is
 * frozen by `freeze-turn-inputs`.
 */
export async function buildLiveToolCatalog(
  deps: LiveToolCatalogDeps,
  args: LiveToolCatalogArgs,
): Promise<ToolRegistry> {
  const { userId, coreMemoryScope, toolSetGlobs } = args;
  const imageTools = deps.imageToolsLoader ? await deps.imageToolsLoader.getTools() : [];
  const skillTools = deps.skillRunner ? await buildSkillTools(deps.skillRunner, { userId }) : [];
  // One `subagent__<name>` tool per row, loaded fresh each turn (CLI CRUD
  // takes effect without a restart). The handler closes over the same
  // per-turn `resolveProvider`, so a sub-agent can target any routable
  // model — including a different provider than the main turn. Joins the
  // built-ins set; the `subagent__` namespace makes a collision with a
  // built-in structurally impossible.
  const subAgentTools = buildSubAgentTools(
    await deps.runInTx((tx) => deps.agentStore.listSubAgents(tx, userId)),
    deps.resolveProvider,
  );
  const mcpTools = deps.mcpRegistry
    ? await deps.mcpRegistry.resolveTools({ toolGlobs: toolSetGlobs })
    : [];
  return composeTurnTools({
    builtIns: offeredBuiltIns(coreMemoryScope, [
      ...deps.tools.snapshot(),
      ...imageTools,
      ...subAgentTools,
    ]),
    skillTools,
    mcpTools,
    toolSetGlobs,
  });
}
