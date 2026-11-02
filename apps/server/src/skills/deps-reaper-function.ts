import type { Inngest } from "inngest";
import type { Result } from "neverthrow";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { SandboxClient } from "../sandbox/index.js";
import { DEPS_REAP_GRACE_DAYS, type ReapSkillVenvsError, reapSkillVenvs } from "./deps-reaper.js";
import type { BundledDistribution, BundledPackagesUnreadable } from "./pyodide-compat.js";
import type { SkillStore } from "./store/index.js";
import { reapWasmWheelDirs, sweepWasmWheelTmpDirs } from "./worker-wasm/wheel-cache.js";

const log = logger.child({ component: "skills.deps-reaper-function" });

export interface SkillDepsReaperDeps {
  runInTx: Transactor;
  store: SkillStore;
  /**
   * Container-capable sandbox. Mounts the same `/skill-venvs` volume the
   * populator writes to. When undefined (wasm-only deployments, or
   * `SANDBOX_RUNTIME` unset locally), the function logs + skips.
   */
  sandbox: SandboxClient | undefined;
  /**
   * Skills runtime image. Must carry `sh`, `find`, `grep` and the
   * `cogmo_skills_runtime.abi` module. Mirrors the value the runner passes
   * to `runOnSysboxContainer` for container workers, so both share image
   * lifecycle and snapshot caches.
   */
  image: string;
  /**
   * Required by the production env contract; passed as `undefined` only
   * by tests that don't exercise the reap path.
   */
  depsCacheVolumeName: string | undefined;
  /**
   * Host directory holding the wasm wheel directories
   * (`ensureWasmPackages`). Unset where the wasm tier publishes none.
   */
  wheelsRoot?: string;
  /**
   * The installed Pyodide distribution, whose version keys the wheel
   * directories a child installs from (`loadBundledPackages`).
   */
  loadBundled: () => Promise<Result<BundledDistribution, BundledPackagesUnreadable>>;
}

/**
 * Daily Inngest scheduled function that sweeps unreachable
 * `/skill-venvs/<hash>/` directories, and the host's wasm wheel
 * directories when `wheelsRoot` is set (a reachable hash's directory for a
 * Pyodide release other than the installed one is unreachable). Unreachable = no `skills` row
 * (enabled or disabled) carries that `lockfile_hash`. A 7-day grace
 * window protects the rollback-then-roll-forward case where a hash
 * temporarily leaves the reachable set; if the rollback sticks past
 * the grace window the venv gets reaped and a re-populate runs on
 * the next invoke.
 *
 * `concurrency: { limit: 1 }` is single-flight within THIS Cogmo
 * instance's Inngest app -- not cross-instance. If two Cogmos with
 * disjoint reachable sets share one Daytona/Docker volume (the
 * documented multi-tenant footgun: see `design/skills.md` -> Security
 * posture), their reapers could delete each other's reachable
 * venvs. The correct mitigation is per-deployment
 * `COGMO_SKILLS_DEPS_VOLUME`, not function-level concurrency.
 *
 * 0 retries: another tick fires tomorrow regardless. A transient
 * sandbox failure today shouldn't keep retrying for hours.
 */
export function createSkillDepsReaper(deps: SkillDepsReaperDeps, inngest: Inngest) {
  return inngest.createFunction(
    {
      id: "skill-venvs-reaper",
      retries: 0,
      concurrency: { limit: 1 },
      // 03:17 daily -- spread away from the top of the hour where most
      // user-facing cron skills cluster.
      triggers: [{ cron: "17 3 * * *" }],
    },
    async ({ step }) => {
      const venvSandbox = venvReapSandbox(deps);
      const wheelsRoot = deps.wheelsRoot;
      if (!venvSandbox && wheelsRoot === undefined) return { skipped: true } as const;

      const reachable = await step.run("list-reachable-hashes", async () => {
        const set = await deps.runInTx((tx) => deps.store.listReachableLockfileHashes(tx));
        return [...set];
      });

      const venvs = venvSandbox
        ? await step.run(
            "reap",
            async (): Promise<{ reapedHashes: string[]; error?: ReapSkillVenvsError["kind"] }> => {
              const r = await reapSkillVenvs({
                sandbox: venvSandbox.sandbox,
                image: deps.image,
                depsCacheVolumeName: venvSandbox.depsCacheVolumeName,
                reachableHashes: new Set(reachable),
              });
              if (r.isErr()) {
                log.warn(
                  { err: r.error.message, kind: r.error.kind },
                  "skill-venvs-reaper: reap step failed",
                );
                return { reapedHashes: [], error: r.error.kind };
              }
              return { reapedHashes: [...r.value.reapedHashes] };
            },
          )
        : ({ skipped: true } as const);

      const wasmWheels =
        wheelsRoot === undefined
          ? ({ skipped: true } as const)
          : await step.run(
              "reap-wasm-wheels",
              async (): Promise<{
                reapedDirs: string[];
                error?: "reap_failed" | "bundled_unreadable";
              }> => {
                // The installed release decides which directories a child installs from.
                const bundled = await deps.loadBundled();
                if (bundled.isErr()) {
                  log.warn(
                    { err: bundled.error.message },
                    "skill-venvs-reaper: Pyodide's lockfile unreadable; sweeping only the wasm wheel root's stale tmp dirs",
                  );
                  const swept = await sweepWasmWheelTmpDirs(wheelsRoot);
                  if (swept.isErr()) {
                    log.warn(
                      { err: swept.error.message },
                      "skill-venvs-reaper: wasm wheel tmp sweep failed",
                    );
                  }
                  return { reapedDirs: [], error: bundled.error.kind };
                }
                const r = await reapWasmWheelDirs({
                  wheelsRoot,
                  reachableHashes: new Set(reachable),
                  pyodideVersion: bundled.value.version,
                  graceDays: DEPS_REAP_GRACE_DAYS,
                });
                if (r.isErr()) {
                  log.warn({ err: r.error.message }, "skill-venvs-reaper: wasm wheel reap failed");
                  return { reapedDirs: [], error: r.error.kind };
                }
                return { reapedDirs: [...r.value.reapedDirs] };
              },
            );

      return { venvs, wasmWheels };
    },
  );
}

/**
 * The sandbox and volume the venv sweep runs on, or undefined when there is
 * no shared venv volume to sweep: no sandbox or volume configured, or a
 * backend whose sandboxes each dispose their own `/skill-venvs` on delete.
 */
function venvReapSandbox(
  deps: SkillDepsReaperDeps,
): { sandbox: SandboxClient; depsCacheVolumeName: string } | undefined {
  if (!deps.sandbox || !deps.depsCacheVolumeName) {
    log.info("skill-venvs-reaper: sandbox or deps volume not configured; skipping venvs");
    return undefined;
  }
  if (deps.sandbox.capabilities.depsCacheSharing === "per-sandbox") {
    log.info(
      { backend: deps.sandbox.backendId },
      "skill-venvs-reaper: backend uses per-sandbox cache; no venvs to reap",
    );
    return undefined;
  }
  return { sandbox: deps.sandbox, depsCacheVolumeName: deps.depsCacheVolumeName };
}
