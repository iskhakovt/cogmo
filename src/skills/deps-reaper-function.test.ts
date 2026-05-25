/**
 * `createSkillDepsReaper` controller tests. Verifies the gating branches
 * — sandbox missing, volume missing, backend advertises per-sandbox
 * cache — without exercising the underlying `reapSkillVenvs` shell
 * pipeline (covered in `deps-reaper.test.ts`).
 */

import { InngestTestEngine } from "@inngest/test";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import { inngest } from "../inngest/client.js";
import type { SandboxCapabilities, SandboxClient } from "../sandbox/index.js";
import { createSkillDepsReaper } from "./deps-reaper-function.js";
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
});
