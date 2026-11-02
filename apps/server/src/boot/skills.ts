/**
 * Stage 3: the skill runner, and the skill crons `cogmo serve` registers.
 */

import { env } from "../env.js";
import { inngest } from "../inngest/index.js";
import { logger } from "../logger.js";
import { createSkillCronFireHandler } from "../skills/cron-fire-handler.js";
import { createSkillCronTicker } from "../skills/cron-ticker.js";
import { createSkillDepsReaper } from "../skills/deps-reaper-function.js";
import { resolveSkillRunAs } from "../skills/run-as.js";
import { SkillRunnerImpl } from "../skills/runner.js";
import { readBootId, reapOrphanedChildGroups } from "../skills/worker-wasm/process-groups.js";
import type { BootstrapOptions, CoreDeps, SandboxDeps, SkillRunnerHandle } from "./stages.js";

const log = logger.child({ component: "boot.skills" });

/**
 * Used by both `cogmo serve` (where the runner is shared between
 * handle-message's `register_skill` tool and the channel adapters' `/skill`
 * admin commands) and `cogmo skills` (where the CLI drives it directly).
 * Tier-2 (sysbox/Daytona) skill execution requires a non-null `sandbox`;
 * CLIs pass `NO_SANDBOX` and accept that tier-2 invocations throw at call
 * time.
 *
 * `reapTier1Children` is true for `cogmo serve` only: the reap kills the
 * tier-1 children a dead Cogmo process left behind, and a CLI process must
 * not touch those of the serve it runs beside (design/skills.md → Tier-1
 * boundary, layer 1 → Process-group records).
 */
export async function bootstrapSkillRunner(
  core: CoreDeps,
  sandbox: SandboxDeps,
  reapTier1Children: boolean,
  opts: BootstrapOptions = {},
): Promise<SkillRunnerHandle> {
  const tier1ChildrenDir = `${env.COGMO_SKILLS_PATH}/.tier1-children`;
  if (reapTier1Children) await reapTier1ChildGroups(tier1ChildrenDir);
  const skillRunner = await SkillRunnerImpl.create({
    store: core.skillStore,
    runInTx: core.runInTx,
    secretsStore: core.secretsStore,
    ...(sandbox.sandbox && { sandbox: sandbox.sandbox }),
    tier2Image: env.COGMO_SKILLS_IMAGE,
    depsCacheVolumeName: env.COGMO_SKILLS_DEPS_VOLUME,
    userTimezone: env.USER_TIMEZONE,
    defaultRunAs: { userId: core.user.id, profileId: core.profile.id },
    skillsRepoPath: env.COGMO_SKILLS_PATH,
    // Pyodide's built-ins, which the host prefetches and tier-1 children load
    // read-only; the stdlib ships inside the distribution.
    pyodidePackageCacheDir: `${env.COGMO_SKILLS_PATH}/.pyodide-cache`,
    tier1: {
      wheelsRoot: tier1WheelsRoot(),
      childrenDir: tier1ChildrenDir,
    },
    poolOptions: {
      min: env.COGMO_SKILLS_POOL_MIN,
      idleShutdownMs: env.COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS,
    },
    ...(opts.skillCtxHttpOverride && { ctxHttp: opts.skillCtxHttpOverride }),
  });
  return { skillRunner };
}

export function createSkillFunctions(
  core: CoreDeps,
  sandbox: SandboxDeps,
  skillRunner: SkillRunnerImpl,
) {
  // Skill cron ticker — parallel 1-min cron that locks due rows from
  // `skills` (where `schedule IS NOT NULL`) and fans out
  // `skills/cron.fire`. Separate from `scheduled-task-ticker` because
  // skills are host-scoped and dispatch via `runner.invoke` rather than
  // the inbound pipeline. See `src/skills/cron-ticker.ts`.
  const skillCronTicker = createSkillCronTicker(
    {
      runInTx: core.runInTx,
      store: core.skillStore,
      userTimezone: env.USER_TIMEZONE,
    },
    inngest,
  );

  // Skill cron fire handler — receives `skills/cron.fire` and invokes
  // the skill with empty inputs, as the identity stored on its row. See
  // `src/skills/cron-fire-handler.ts`.
  const skillCronFire = createSkillCronFireHandler(
    {
      runner: skillRunner,
      runInTx: core.runInTx,
      store: core.skillStore,
      resolveRunAs: (identity) => resolveSkillRunAs(core, identity),
    },
    inngest,
  );

  // Daily reaper that sweeps unreachable `/skill-venvs/<hash>/` dirs after
  // the grace window. See `src/skills/deps-reaper-function.ts`.
  const skillDepsReaper = createSkillDepsReaper(
    {
      runInTx: core.runInTx,
      store: core.skillStore,
      sandbox: sandbox.sandbox ?? undefined,
      image: env.COGMO_SKILLS_IMAGE,
      depsCacheVolumeName: env.COGMO_SKILLS_DEPS_VOLUME,
      wheelsRoot: tier1WheelsRoot(),
    },
    inngest,
  );

  return { skillCronTicker, skillCronFire, skillDepsReaper };
}

/**
 * Kill the tier-1 children a dead Cogmo process of this boot left behind,
 * which nothing else bounds without the per-child cgroup, before the runner
 * serves.
 */
async function reapTier1ChildGroups(childrenDir: string): Promise<void> {
  const reaped = await reapOrphanedChildGroups(childrenDir, { bootId: await readBootId() });
  const summary = {
    killed: reaped.killed.map((r) => r.pid),
    owned: reaped.owned.map((r) => r.pid),
    stale: reaped.stale,
  };
  if (reaped.killed.length > 0) {
    log.warn(summary, "killed orphaned tier-1 child process groups at boot");
  } else if (reaped.owned.length > 0 || reaped.stale.length > 0) {
    log.info(summary, "tier-1 child process-group records reaped at boot");
  }
}

/** The hash-verified pure-Python wheels tier-1 children install from. */
function tier1WheelsRoot(): string {
  return `${env.COGMO_SKILLS_PATH}/.pyodide-wheels`;
}
