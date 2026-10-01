/**
 * Stage 3: the skill runner, and the skill crons `cogmo serve` registers.
 */

import { env } from "../env.js";
import { inngest } from "../inngest/index.js";
import { createSkillCronFireHandler } from "../skills/cron-fire-handler.js";
import { createSkillCronTicker } from "../skills/cron-ticker.js";
import { createSkillDepsReaper } from "../skills/deps-reaper-function.js";
import { resolveSkillRunAs } from "../skills/run-as.js";
import { SkillRunnerImpl } from "../skills/runner.js";
import type { BootstrapOptions, CoreDeps, SandboxDeps, SkillRunnerHandle } from "./stages.js";

/**
 * Used by both `cogmo serve` (where the runner is shared between
 * handle-message's `register_skill` tool and the channel adapters' `/skill`
 * admin commands) and `cogmo skills` (where the CLI drives it directly).
 * Tier-2 (sysbox/Daytona) skill execution requires a non-null `sandbox`;
 * CLIs pass `NO_SANDBOX` and accept that tier-2 invocations throw at call
 * time.
 */
export async function bootstrapSkillRunner(
  core: CoreDeps,
  sandbox: SandboxDeps,
  opts: BootstrapOptions = {},
): Promise<SkillRunnerHandle> {
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
    // Cache Pyodide's pre-built packages under the skills repo's git dir
    // so JsDelivr fetches don't repeat across worker spawns. Only matters
    // for skills that micropip-install pure-Python wheels — the stdlib is
    // always bundled.
    pyodidePackageCacheDir: `${env.COGMO_SKILLS_PATH}/.pyodide-cache`,
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
    },
    inngest,
  );

  return { skillCronTicker, skillCronFire, skillDepsReaper };
}
