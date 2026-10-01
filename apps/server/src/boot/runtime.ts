/**
 * Stage 4: the agent runtime `cogmo serve` runs — every Inngest function, the
 * channel adapters, and the long-lived bookkeeping a one-shot CLI must not
 * start. The order below is the construction order: the model catalog loads
 * before the channels start, the runtime defaults are seeded before
 * `startChannels` matches the web channel's adapter, and the MCP registry
 * exists before any Transport is built over it.
 */

import { createWebTools } from "../agent/web-tools.js";
import { env } from "../env.js";
import type { SkillRunnerImpl } from "../skills/runner.js";
import { createAgentFunctions, createAgentTools, createConversationTriggers } from "./agent.js";
import { createCodingRuntime } from "./coding.js";
import { createModelCatalogFunctions, loadLiveModelCatalog } from "./llm.js";
import { seedRuntimeDefaults } from "./locked-bootstrap.js";
import { startMcpRegistry } from "./mcp.js";
import { createSkillFunctions } from "./skills.js";
import type { BootstrapOptions, CoreDeps, RuntimeDeps, SandboxDeps } from "./stages.js";
import { createSessionFunctions, sessionTiming, startTransport } from "./transport.js";

export async function bootstrapRuntime(
  core: CoreDeps,
  sandbox: SandboxDeps,
  skillRunner: SkillRunnerImpl,
  opts: BootstrapOptions = {},
): Promise<RuntimeDeps> {
  await loadLiveModelCatalog(core);
  const coding = createCodingRuntime(core, sandbox, skillRunner, opts);

  // Tool clients live with the agent loop that consumes them. Core
  // exposes credentials as strings; runtime turns them into clients.
  const webTools = createWebTools(core.tavilyKey, core.openrouterKey);

  // Fal image catalog + web channel, under the bootstrap lock; the web channel
  // must exist before `startChannels` matches its placeholder adapter.
  await seedRuntimeDefaults(
    {
      bootstrapLock: core.bootstrapLock,
      runInTx: core.runInTx,
      agentStore: core.agentStore,
      transportStore: core.transportStore,
      secretsStore: core.secretsStore,
    },
    { userId: core.user.id, ...(env.FAL_API_KEY && { envFalApiKey: env.FAL_API_KEY }) },
  );
  const agentTools = createAgentTools(core, webTools, opts);
  const timing = sessionTiming();
  const mcpRegistry = await startMcpRegistry(core);
  const triggers = createConversationTriggers(core, agentTools.promptSource);

  const transport = await startTransport(core, {
    idleTimeoutMs: timing.idleTimeoutMs,
    skillRunner,
    mcpRegistry,
    codingStreamingRegistry: coding.codingStreamingRegistry,
    triggerReflection: triggers.reflectionTrigger,
    compactConversation: triggers.compactionTrigger,
  });
  const session = createSessionFunctions(core, timing);
  const modelCatalogFunctions = createModelCatalogFunctions(core);
  const agent = createAgentFunctions(
    core,
    {
      agentTools,
      timing,
      deliveryRouter: transport.deliveryRouter,
      codingServiceFactory: coding.codingServiceFactory,
      skillRunner,
      mcpRegistry,
    },
    opts,
  );
  const skills = createSkillFunctions(core, sandbox, skillRunner);

  // biome-ignore lint/suspicious/noExplicitAny: Inngest function types vary by trigger
  const functions: any[] = [
    agent.handleMessage,
    session.idleTimer,
    agent.observer,
    agent.recoverConversation,
    agent.handleMessageReconcile,
    agent.scheduledTaskTicker,
    agent.scheduledTaskFire,
    skills.skillCronTicker,
    skills.skillCronFire,
    skills.skillDepsReaper,
    session.boundaryWaiter,
    session.boundaryJanitor,
    agent.pipelineStageRunner,
    agent.pipelineGateWaiter,
    agent.pipelineGateResolver,
    ...session.debounceFunctions,
    ...transport.channelFunctions,
    ...coding.codingFunctions,
    ...modelCatalogFunctions,
  ];

  return {
    functions,
    adapters: transport.adapters,
    mcpRegistry,
    webTransport: transport.webTransport,
    webStreamRegistry: transport.webStreamRegistry,
    codingStreams: coding.codingStreamingRegistry,
  };
}
