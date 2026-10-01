import { logger } from "../logger.js";
import { finishesWithin } from "../util/finishes-within.js";
import type { CoreDeps, RuntimeDeps, SandboxDeps, SkillRunnerHandle } from "./stages.js";

/** What `cogmo serve` tears down on exit. */
export interface ServeResources {
  /** Ends open chat streams, then drains requests for up to `drainMs`. */
  web: { close(drainMs: number): Promise<void> };
  adapters: ReadonlyArray<{ channelType: string; adapter: { stop(): Promise<void> } }>;
  /** Stops the sweep of coding progress streams. */
  codingStreams: { close(): void };
  mcpRegistry: { stop(): Promise<void> };
  /** Disposes the skill runner's tier-2 warm pool, tearing its containers down. */
  skills: { shutdown(): Promise<void> };
  sandbox: { shutdown(): Promise<void> } | null;
  /**
   * Marks this process's `cogmo_instances` row stopped; `null` without one.
   * Skipped when the skills pool or sandbox step didn't finish.
   */
  closeInstance: (() => Promise<void>) | null;
}

export interface ShutdownBounds {
  /** How long in-flight web requests get before their connections are closed. */
  webDrainMs: number;
  /** Cap on every other step, and on the web step past its drain. */
  stepMs: number;
}

export const SERVE_SHUTDOWN_BOUNDS: ShutdownBounds = { webDrainMs: 3_000, stepMs: 5_000 };

export type StepOutcome =
  | { step: string; outcome: "done" }
  | { step: string; outcome: "timed_out"; ms: number }
  | { step: string; outcome: "failed"; error: unknown }
  | { step: string; outcome: "skipped"; reason: string };

/**
 * Tear down `cogmo serve`: the web server first, so no request reaches a
 * stopped dependency, then the channel adapters concurrently, the coding
 * streams' sweep, MCP, the skills pool, the sandbox, and the instance row.
 * Each step is bounded, and one that overruns or throws doesn't stop the
 * next. The instance row stays open when the skills pool or sandbox step
 * didn't finish, so the next boot reaps the containers they left. Never
 * rejects; returns each step's outcome, in that order.
 */
export async function shutdownServe(
  resources: ServeResources,
  bounds: ShutdownBounds,
): Promise<ReadonlyArray<StepOutcome>> {
  const { web, adapters, codingStreams, mcpRegistry, skills, sandbox, closeInstance } = resources;
  const { webDrainMs, stepMs } = bounds;
  const webOutcome = await bounded("web server", webDrainMs + stepMs, () => web.close(webDrainMs));
  const adapterOutcomes = await Promise.all(
    adapters.map(({ channelType, adapter }) =>
      bounded(`${channelType} adapter`, stepMs, () => adapter.stop()),
    ),
  );
  const streamsOutcome = await bounded("coding streams", stepMs, async () => codingStreams.close());
  const mcpOutcome = await bounded("mcp", stepMs, () => mcpRegistry.stop());
  const skillsOutcome = await bounded("skills pool", stepMs, () => skills.shutdown());
  const sandboxOutcomes = sandbox
    ? [await bounded("sandbox", stepMs, () => sandbox.shutdown())]
    : [];
  // The next boot reaps the containers of instances never marked stopped.
  const leftContainers = [skillsOutcome, ...sandboxOutcomes].some(
    ({ outcome }) => outcome !== "done",
  );
  const instanceOutcomes: StepOutcome[] = [];
  if (closeInstance && leftContainers) {
    instanceOutcomes.push({
      step: "sandbox instance",
      outcome: "skipped",
      reason: "a container teardown didn't finish; left open so the next boot reaps it",
    });
  } else if (closeInstance) {
    instanceOutcomes.push(await bounded("sandbox instance", stepMs, closeInstance));
  }
  return [
    webOutcome,
    ...adapterOutcomes,
    streamsOutcome,
    mcpOutcome,
    skillsOutcome,
    ...sandboxOutcomes,
    ...instanceOutcomes,
  ];
}

/** What `cogmo serve` tears down, from what the bootstrap and the web UI started. */
export function serveResources(
  boot: Pick<CoreDeps, "runInTx" | "sandboxStore"> &
    Pick<SandboxDeps, "sandbox" | "sandboxInstanceId"> &
    Pick<RuntimeDeps, "adapters" | "codingStreams" | "mcpRegistry"> &
    SkillRunnerHandle,
  web: ServeResources["web"],
): ServeResources {
  const { runInTx, sandboxStore, sandboxInstanceId } = boot;
  return {
    web,
    adapters: boot.adapters,
    codingStreams: boot.codingStreams,
    mcpRegistry: boot.mcpRegistry,
    skills: boot.skillRunner,
    sandbox: boot.sandbox,
    closeInstance: sandboxInstanceId
      ? () => runInTx((tx) => sandboxStore.closeInstance(tx, sandboxInstanceId))
      : null,
  };
}

export function logShutdownOutcomes(outcomes: ReadonlyArray<StepOutcome>): void {
  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "done":
        logger.debug({ step: outcome.step }, "shutdown step done");
        break;
      case "timed_out":
        logger.warn({ step: outcome.step, ms: outcome.ms }, "shutdown step timed out");
        break;
      case "failed":
        logger.error({ step: outcome.step, err: outcome.error }, "shutdown step failed");
        break;
      case "skipped":
        logger.warn({ step: outcome.step, reason: outcome.reason }, "shutdown step skipped");
        break;
    }
  }
}

async function bounded(step: string, ms: number, run: () => Promise<void>): Promise<StepOutcome> {
  try {
    return (await finishesWithin(Promise.try(run), ms))
      ? { step, outcome: "done" }
      : { step, outcome: "timed_out", ms };
  } catch (error) {
    return { step, outcome: "failed", error };
  }
}
