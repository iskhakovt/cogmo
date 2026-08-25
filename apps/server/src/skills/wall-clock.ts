import type { SkillManifest } from "./types.js";

/**
 * Wall clock a task gets when its manifest declares no
 * `resources.wall_clock_s`. The tiers differ because a container pays a
 * startup cost a WASM worker does not.
 *
 * Both the runtime that enforces the budget and anything sizing itself
 * underneath that budget have to read the same number for a given tier, so
 * the pair lives in one place on the TypeScript side — a second copy is how
 * one of them ends up reasoning about the wrong ceiling.
 *
 * `supervisor.py` keeps its own `DEFAULT_WALL_CLOCK_S = 60` because it runs
 * in the container with no access to this module. That copy is only reachable
 * when `task_invoke` carries no `wallClockS`, which the host always sends for
 * a manifest that declares one; keep the two in step by hand.
 */
export const DEFAULT_WALL_CLOCK_S: Readonly<Record<SkillManifest["tier"], number>> = {
  wasm: 30,
  container: 60,
};
