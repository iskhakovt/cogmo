/**
 * `createSkillDepsReaper` controller tests. Verifies the gating branches
 * — sandbox missing, volume missing, backend advertises per-sandbox
 * cache — without exercising the underlying `reapSkillVenvs` shell
 * pipeline (covered in `deps-reaper.test.ts`).
 */

import { chmod, mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InngestTestEngine } from "@inngest/test";
import { err } from "neverthrow";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import type { SandboxCapabilities, SandboxClient } from "../sandbox/index.js";
import { createSkillDepsReaper } from "./deps-reaper-function.js";
import { loadBundledPackages } from "./pyodide-compat.js";
import type { SkillStore } from "./store/index.js";

const SCHEDULED_EVENT = {
  name: "inngest/function.invoked",
  data: {},
} as const;

function sharedVolumeCapabilities(): SandboxCapabilities {
  return {
    siblingContainers: "host-proxy",
    hostBindMount: true,
    customImage: true,
    volumes: "docker",
    workingTreeTransport: "bind-mount",
    depsCacheSharing: "shared-volume",
  };
}

function perSandboxCapabilities(): SandboxCapabilities {
  return {
    siblingContainers: "sandbox-internal",
    hostBindMount: false,
    customImage: true,
    volumes: "managed",
    workingTreeTransport: "git-remote",
    depsCacheSharing: "per-sandbox",
  };
}

const runInTx: Transactor = (cb) => cb({ __mockTx: true } as never);

describe("createSkillDepsReaper", () => {
  it("skips when no sandbox is configured", async () => {
    const store = mock<SkillStore>();
    const fn = createSkillDepsReaper(
      {
        runInTx,
        store,
        sandbox: undefined,
        image: "cogmo-skills:test",
        depsCacheVolumeName: "deps-vol-x",
        loadBundled: loadBundledPackages,
      },
      inngest,
    );

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [SCHEDULED_EVENT],
    }).execute();

    expect(result).toEqual({ skipped: true });
    expect(store.listReachableLockfileHashes).not.toHaveBeenCalled();
  });

  it("skips when no deps-cache volume name is configured", async () => {
    const store = mock<SkillStore>();
    const sandbox = mock<SandboxClient>({
      backendId: "local-docker",
      capabilities: sharedVolumeCapabilities(),
    });
    const fn = createSkillDepsReaper(
      {
        runInTx,
        store,
        sandbox,
        image: "cogmo-skills:test",
        depsCacheVolumeName: undefined,
        loadBundled: loadBundledPackages,
      },
      inngest,
    );

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [SCHEDULED_EVENT],
    }).execute();

    expect(result).toEqual({ skipped: true });
    expect(store.listReachableLockfileHashes).not.toHaveBeenCalled();
  });

  it("skips when the backend advertises depsCacheSharing: 'per-sandbox'", async () => {
    const store = mock<SkillStore>();
    // Even with a volume name passed in, the per-sandbox capability wins —
    // there's no shared volume to reap. Matches the runner's gating.
    const sandbox = mock<SandboxClient>({
      backendId: "daytona",
      capabilities: perSandboxCapabilities(),
    });
    const fn = createSkillDepsReaper(
      {
        runInTx,
        store,
        sandbox,
        image: "cogmo-skills:test",
        depsCacheVolumeName: "deps-vol-x",
        loadBundled: loadBundledPackages,
      },
      inngest,
    );

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [SCHEDULED_EVENT],
    }).execute();

    expect(result).toEqual({ skipped: true });
    expect(store.listReachableLockfileHashes).not.toHaveBeenCalled();
    expect(sandbox.create).not.toHaveBeenCalled();
  });

  it("reaps the tier-1 wheel directories with the reachable set under the installed Pyodide release", async () => {
    const { version } = (await loadBundledPackages())._unsafeUnwrap();
    const wheelsRoot = await mkdtemp(join(tmpdir(), "deps-reaper-wheels-"));
    const reachable = `${"a".repeat(64)}-pyodide${version}`;
    try {
      const unreachable = `${"b".repeat(64)}-pyodide${version}`;
      const previousRelease = `${"a".repeat(64)}-pyodide0.0.1`;
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      for (const name of [reachable, unreachable, previousRelease]) {
        await mkdir(join(wheelsRoot, name));
        await chmod(join(wheelsRoot, name), 0o555);
        await utimes(join(wheelsRoot, name), eightDaysAgo, eightDaysAgo);
      }
      const store = mock<SkillStore>();
      store.listReachableLockfileHashes.mockResolvedValue(new Set(["a".repeat(64)]));
      const fn = createSkillDepsReaper(
        {
          runInTx,
          store,
          sandbox: undefined,
          image: "cogmo-skills:test",
          depsCacheVolumeName: undefined,
          wheelsRoot,
          loadBundled: loadBundledPackages,
        },
        inngest,
      );

      const { result } = await new InngestTestEngine({
        function: fn,
        events: [SCHEDULED_EVENT],
      }).execute();

      expect(result).toEqual({
        venvs: { skipped: true },
        tier1Wheels: { reapedDirs: expect.arrayContaining([unreachable, previousRelease]) },
      });
      expect(await readdir(wheelsRoot)).toEqual([reachable]);
    } finally {
      await chmod(join(wheelsRoot, reachable), 0o755).catch(() => {});
      await rm(wheelsRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "still reports bundled_unreadable when the tmp sweep itself fails",
    async () => {
      const wheelsRoot = await mkdtemp(join(tmpdir(), "deps-reaper-wheels-"));
      try {
        await chmod(wheelsRoot, 0o000);
        const store = mock<SkillStore>();
        store.listReachableLockfileHashes.mockResolvedValue(new Set());
        const fn = createSkillDepsReaper(
          {
            runInTx,
            store,
            sandbox: undefined,
            image: "cogmo-skills:test",
            depsCacheVolumeName: undefined,
            wheelsRoot,
            loadBundled: async () =>
              err({ kind: "bundled_unreadable" as const, message: "pyodide-lock.json: ENOENT" }),
          },
          inngest,
        );

        const { result, error } = await new InngestTestEngine({
          function: fn,
          events: [SCHEDULED_EVENT],
        }).execute();

        expect(error).toBeUndefined();
        expect(result).toMatchObject({
          tier1Wheels: { reapedDirs: [], error: "bundled_unreadable" },
        });
      } finally {
        await chmod(wheelsRoot, 0o700);
        await rm(wheelsRoot, { recursive: true, force: true });
      }
    },
  );

  it("sweeps only the wheel root's stale tmp dirs when Pyodide's lockfile cannot be read", async () => {
    const wheelsRoot = await mkdtemp(join(tmpdir(), "deps-reaper-wheels-"));
    const unreachable = `${"b".repeat(64)}-pyodide314.0.7`;
    try {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await mkdir(join(wheelsRoot, unreachable));
      await utimes(join(wheelsRoot, unreachable), eightDaysAgo, eightDaysAgo);
      const staleTmp = `${"c".repeat(64)}-pyodide0.0.1.tmp.leftover`;
      await mkdir(join(wheelsRoot, staleTmp));
      await utimes(join(wheelsRoot, staleTmp), eightDaysAgo, eightDaysAgo);
      const store = mock<SkillStore>();
      store.listReachableLockfileHashes.mockResolvedValue(new Set());
      const fn = createSkillDepsReaper(
        {
          runInTx,
          store,
          sandbox: undefined,
          image: "cogmo-skills:test",
          depsCacheVolumeName: undefined,
          wheelsRoot,
          loadBundled: async () =>
            err({ kind: "bundled_unreadable" as const, message: "pyodide-lock.json: ENOENT" }),
        },
        inngest,
      );

      const { result } = await new InngestTestEngine({
        function: fn,
        events: [SCHEDULED_EVENT],
      }).execute();

      expect(result).toEqual({
        venvs: { skipped: true },
        tier1Wheels: { reapedDirs: [], error: "bundled_unreadable" },
      });
      expect(await readdir(wheelsRoot)).toEqual([unreachable]);
    } finally {
      await rm(wheelsRoot, { recursive: true, force: true });
    }
  });
});
