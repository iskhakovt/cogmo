/**
 * Stage 3: the skill runner, and the skill crons `cogmo serve` registers.
 */

import { ResultAsync } from "neverthrow";
import { env } from "../env.js";
import { inngest } from "../inngest/index.js";
import { logger } from "../logger.js";
import { createSkillCronFireHandler } from "../skills/cron-fire-handler.js";
import { createSkillCronTicker } from "../skills/cron-ticker.js";
import { mirrorMainBestEffort } from "../skills/deploy/mirror.js";
import { createSkillDepsReaper } from "../skills/deps-reaper-function.js";
import { loadBundledPackages } from "../skills/pyodide-compat.js";
import { resolveSkillRunAs } from "../skills/run-as.js";
import { SkillRunnerImpl } from "../skills/runner.js";
import { createSkillRunsSweeper } from "../skills/runs-sweeper.js";
import {
  readBootId,
  readStartTime,
  reapOrphanedChildGroups,
} from "../skills/worker-wasm/process-groups.js";
import { describeError } from "../util/describe-error.js";
import type {
  BootstrapOptions,
  CoreDeps,
  SandboxDeps,
  SkillRunnerHandle,
  WasmReapHost,
} from "./stages.js";

const log = logger.child({ component: "boot.skills" });

/** What the process booting the runner owns besides it. */
interface SkillRunnerOwnership {
  /**
   * True for `cogmo serve` only: the reap kills the wasm children a dead
   * Cogmo process left behind, and a CLI process must not touch those of the
   * serve it runs beside (design/skills.md → Wasm-tier boundary, layer 1 →
   * Process-group records).
   */
  reapWasmChildren: boolean;
}

/**
 * Used by both `cogmo serve` (where the runner is shared between
 * handle-message's `register_skill` tool and the channel adapters' `/skill`
 * admin commands) and `cogmo skills` (where the CLI drives it directly).
 * Container (sysbox/Daytona) skill execution requires a non-null `sandbox`;
 * CLIs pass `NO_SANDBOX` and accept that container invocations throw at call
 * time.
 */
export async function bootstrapSkillRunner(
  core: CoreDeps,
  sandbox: SandboxDeps,
  ownership: SkillRunnerOwnership,
  opts: BootstrapOptions = {},
): Promise<SkillRunnerHandle> {
  const wasmChildrenDir = `${env.COGMO_SKILLS_PATH}/.wasm-children`;
  if (ownership.reapWasmChildren) {
    await reapWasmChildGroups(
      wasmChildrenDir,
      opts.wasmReapHostOverride ?? { platform: process.platform, readBootId },
    );
  }
  const skillRunner = await SkillRunnerImpl.create({
    store: core.skillStore,
    runInTx: core.runInTx,
    secretsStore: core.secretsStore,
    ...(sandbox.sandbox && { sandbox: sandbox.sandbox }),
    containerImage: env.COGMO_SKILLS_IMAGE,
    depsCacheVolumeName: env.COGMO_SKILLS_DEPS_VOLUME,
    userTimezone: env.USER_TIMEZONE,
    defaultRunAs: { userId: core.user.id, profileId: core.profile.id },
    skillsRepoPath: env.COGMO_SKILLS_PATH,
    // Pyodide's built-ins, which the host downloads and verifies and wasm
    // children load read-only; the stdlib ships inside the distribution.
    pyodidePackageCacheDir: `${env.COGMO_SKILLS_PATH}/.pyodide-cache`,
    wasm: {
      wheelsRoot: wasmWheelsRoot(),
      childrenDir: wasmChildrenDir,
    },
    poolOptions: {
      min: env.COGMO_SKILLS_POOL_MIN,
      idleShutdownMs: env.COGMO_SKILLS_POOL_IDLE_SHUTDOWN_MS,
    },
    ...(opts.skillCtxHttpOverride && { ctxHttp: opts.skillCtxHttpOverride }),
  });
  return { skillRunner };
}

/**
 * Push the skills repo's `main` to its `origin` in the background, for
 * `cogmo serve`. A coding task on a git-remote backend (Daytona) branches
 * from the remote's `main`, so a commit only local `main` holds, the layout
 * commit this boot may have made or a deploy whose push failed, would fail
 * the draft's register as `non_fast_forward` (design/skills.md → Repo
 * location → Mirror state).
 */
export function scheduleSkillsMirror(core: CoreDeps): void {
  void mirrorMainBestEffort(
    { runInTx: core.runInTx, secretsStore: core.secretsStore },
    env.COGMO_SKILLS_PATH,
  );
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
      wheelsRoot: wasmWheelsRoot(),
      loadBundled: loadBundledPackages,
    },
    inngest,
  );

  // Finishes runs stuck in flight every 5 min. See `src/skills/runs-sweeper.ts`.
  const skillRunsSweeper = createSkillRunsSweeper(
    { runInTx: core.runInTx, store: core.skillStore },
    inngest,
  );

  return { skillCronTicker, skillCronFire, skillDepsReaper, skillRunsSweeper };
}

/**
 * Kill the wasm children a dead Cogmo process of this boot left behind,
 * which nothing else bounds without the per-child cgroup, before the runner
 * serves. The records pin processes by `/proc` entries, so a host without
 * them (anything but Linux), or one whose boot id cannot be read, skips the
 * reap with a log line rather than failing the boot.
 */
async function reapWasmChildGroups(childrenDir: string, host: WasmReapHost): Promise<void> {
  if (host.platform !== "linux") {
    log.info(
      { platform: host.platform },
      "skipping the wasm child reap: process-group records need Linux's /proc",
    );
    return;
  }
  const bootId = await ResultAsync.fromPromise(host.readBootId(), describeError);
  if (bootId.isErr()) {
    log.warn({ err: bootId.error }, "skipping the wasm child reap: the boot id is unreadable");
    return;
  }
  const reaped = await reapOrphanedChildGroups(childrenDir, {
    bootId: bootId.value,
    readStartTime,
  });
  const summary = {
    killed: reaped.killed.map((r) => r.pid),
    owned: reaped.owned.map((r) => r.pid),
    stale: reaped.stale,
    unjudged: reaped.unjudged,
  };
  if (reaped.unjudged.length > 0) {
    log.warn(summary, "left wasm child records whose processes /proc could not show");
  }
  if (reaped.killed.length > 0) {
    log.warn(summary, "killed orphaned wasm child process groups at boot");
  } else if (reaped.owned.length > 0 || reaped.stale.length > 0) {
    log.info(summary, "wasm child process-group records reaped at boot");
  }
}

/** The hash-verified pure-Python wheels wasm children install from. */
function wasmWheelsRoot(): string {
  return `${env.COGMO_SKILLS_PATH}/.pyodide-wheels`;
}
