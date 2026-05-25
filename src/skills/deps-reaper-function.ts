import type { Inngest } from "inngest";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { SandboxClient } from "../sandbox/index.js";
import { reapSkillVenvs } from "./deps-reaper.js";
import type { SkillStore } from "./store/index.js";

const log = logger.child({ component: "skills.deps-reaper-function" });

export interface SkillDepsReaperDeps {
  runInTx: Transactor;
  store: SkillStore;
  /**
   * Tier-2-capable sandbox. Mounts the same `/skill-venvs` volume the
   * populator writes to. When undefined (tier-1-only deployments, or
   * `SANDBOX_RUNTIME` unset locally), the function logs + skips.
   */
  sandbox: SandboxClient | undefined;
  /**
   * Skills runtime image. Must carry `sh`, `find`, `grep`. Mirrors the
   * value the runner passes to `runOnSysboxContainer` for tier-2
   * workers, so both share image lifecycle and snapshot caches.
   */
  image: string;
  /**
   * Required by the production env contract; passed as `undefined` only
   * by tests that don't exercise the reap path.
   */
  depsCacheVolumeName: string | undefined;
}

/**
 * Daily Inngest scheduled function that sweeps unreachable
 * `/skill-venvs/<hash>/` directories. Unreachable = no `skills` row
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
      if (!deps.sandbox || !deps.depsCacheVolumeName) {
        log.info("skill-venvs-reaper: sandbox or deps volume not configured; skipping");
        return { skipped: true } as const;
      }
      if (deps.sandbox.capabilities.depsCacheSharing === "per-sandbox") {
        // No persistent shared volume to sweep — each sandbox already
        // disposes its container-local /skill-venvs on delete.
        log.info(
          { backend: deps.sandbox.backendId },
          "skill-venvs-reaper: backend uses per-sandbox cache; nothing to reap",
        );
        return { skipped: true } as const;
      }
      const sandbox = deps.sandbox;
      const depsCacheVolumeName = deps.depsCacheVolumeName;

      const reachable = await step.run("list-reachable-hashes", async () => {
        const set = await deps.runInTx((tx) => deps.store.listReachableLockfileHashes(tx));
        return [...set];
      });

      const result = await step.run("reap", async () => {
        const r = await reapSkillVenvs({
          sandbox,
          image: deps.image,
          depsCacheVolumeName,
          reachableHashes: new Set(reachable),
        });
        if (r.isErr()) {
          log.warn(
            { err: r.error.message, kind: r.error.kind },
            "skill-venvs-reaper: reap step failed",
          );
          return { reapedHashes: [] as string[], error: r.error.kind };
        }
        return { reapedHashes: [...r.value.reapedHashes] };
      });

      return result;
    },
  );
}
