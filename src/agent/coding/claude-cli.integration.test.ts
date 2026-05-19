/// <reference path="../../../test/vitest.d.ts" />

/**
 * Runs `ClaudeCodeBackend` against the real `claude` binary baked into
 * `cogmo-devbase:test`, with `/v1/messages` proxied through llmock for
 * record/replay. CLI-side behavior changes — including any future
 * regression to the plan-mode control_request wedge — surface here even
 * without a fresh recording, because the actual binary is re-deriving
 * its stream-json output from the captured API conversation each time.
 *
 * Record: `RECORD=1 ANTHROPIC_API_KEY=… pnpm test:integration <this file>`.
 * Replay (CI default): free. Image-presence gate: run
 * `VERSION=test docker buildx bake --load devbase` locally, or rely on
 * the sysbox-e2e workflow's bake step in CI.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Transactor } from "../../db/index.js";
import { LocalDockerSandboxClient } from "../../sandbox/index.js";
import { DrizzleSandboxStore } from "../../sandbox/store/index.js";
import { LABEL_INSTANCE, LABEL_MANAGED } from "../../sandbox/supervisor.js";
import type { ResourceLimits } from "../../sandbox/types.js";
import { createTestDatabase } from "../../test/pglite.js";
import type { CodingEvent } from "./backend.js";
import { ClaudeCodeBackend } from "./claude.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

const DEVBASE_IMAGE = "ghcr.io/iskhakovt/cogmo-devbase:test";

const RESOURCE_LIMITS: ResourceLimits = {
  cpus: 1.0,
  memory_bytes: 512 * 1024 * 1024,
  pids: 256,
};

let tx: Transactor;
let closeDb: () => Promise<void>;
let store: DrizzleSandboxStore;
let docker: Docker;
let imagePresent = false;
let bridgeGateway: string | null = null;
let workspaceTmp: string | null = null;
const sandboxes: LocalDockerSandboxClient[] = [];
const homeVolumes: string[] = [];
const testFileInstanceIds: string[] = [];

beforeAll(async () => {
  docker = new Docker();
  try {
    await docker.ping();
  } catch (err) {
    throw new Error(
      `Docker daemon unreachable — claude-cli integration test requires Docker. ${(err as Error).message}`,
    );
  }

  try {
    await docker.getImage(DEVBASE_IMAGE).inspect();
    imagePresent = true;
  } catch {
    imagePresent = false;
  }

  if (!imagePresent) return;

  // Default bridge gateway = the address the container can reach back
  // to the host on. Resolved dynamically rather than hard-coding 172.17.0.1
  // so docker-rootless / custom-bip setups work. `host.docker.internal`
  // isn't an option here — the supervisor doesn't set ExtraHosts and we
  // don't want to change production container config for a test seam.
  const bridge = await docker.getNetwork("bridge").inspect();
  bridgeGateway = bridge.IPAM?.Config?.[0]?.Gateway ?? null;
  if (!bridgeGateway) {
    throw new Error(
      "Could not resolve docker bridge gateway IP from `docker network inspect bridge`",
    );
  }

  ({ tx, close: closeDb } = await createTestDatabase());
  store = new DrizzleSandboxStore();

  // The model needs something concrete in /workspace to plan against —
  // an empty directory makes it bail without ever calling ExitPlanMode,
  // which would pass the test trivially and miss the regression.
  workspaceTmp = mkdtempSync(join(tmpdir(), "cogmo-claude-cli-it-"));
  writeFileSync(
    join(workspaceTmp, "greet.ts"),
    `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
  );
}, 60_000);

afterAll(async () => {
  if (!imagePresent) return;
  for (const s of sandboxes) await s.shutdown();
  for (const instanceId of testFileInstanceIds) {
    const leftover = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_INSTANCE}=${instanceId}`] },
    });
    for (const c of leftover) {
      await docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => {});
    }
  }
  for (const v of homeVolumes) {
    await docker
      .getVolume(v)
      .remove({ force: true })
      .catch(() => {});
  }
  if (workspaceTmp) rmSync(workspaceTmp, { recursive: true, force: true });
  await closeDb();
});

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Swap llmock's loopback host for the docker bridge gateway and strip
// the trailing /v1 — Anthropic's SDK appends /v1/messages back on.
function llmockUrlForContainer(): string {
  const llmockBaseUrl = inject("llmockBaseUrl");
  const parsed = new URL(llmockBaseUrl);
  if (!bridgeGateway) throw new Error("bridgeGateway not resolved — beforeAll skipped?");
  parsed.hostname = bridgeGateway;
  parsed.pathname = parsed.pathname.replace(/\/v1\/?$/, "");
  return parsed.toString().replace(/\/$/, "");
}

async function bootSandbox(): Promise<{ sandbox: LocalDockerSandboxClient; instanceId: string }> {
  const inst = await tx((trx) =>
    store.insertInstance(trx, { host: "test-host", pid: process.pid }),
  );
  testFileInstanceIds.push(inst.id);
  const sandbox = await LocalDockerSandboxClient.create({
    docker,
    store,
    runInTx: tx,
    runtime: "runc",
    instanceId: inst.id,
  });
  sandboxes.push(sandbox);
  return { sandbox, instanceId: inst.id };
}

const repo: CodingRepoRow = {
  id: "00000000-0000-7000-8000-000000000001",
  name: "cogmo",
  localPath: "/workspace",
  defaultBranch: "main",
  remoteUrl: "git@github.com:test/cogmo.git",
  devcontainer: null,
  allowedBackends: ["claude"],
  verifyCommand: "echo verify",
  taskTokenBudget: 100_000,
  taskWallTimeSeconds: 600,
  maxConcurrentTasks: 1,
  identityName: "default",
  verifyTimeoutSeconds: 600,
  createdAt: new Date(),
};

function makeTask(taskId: string): CodingTaskRow {
  return {
    id: taskId,
    repoId: repo.id,
    conversationId: null,
    // Pointed at the planted greet.ts so the model has something concrete
    // to plan against — empty workspaces make the model bail without
    // calling ExitPlanMode, leaving the regression untested.
    goal: "Read /workspace/greet.ts. Plan a single change: add a JSDoc comment to the greet function describing what it returns. Keep the plan to one short paragraph.",
    triggerSource: "user",
    triggerRef: null,
    backend: "claude",
    worktreeAssignment: {
      type: "host-path",
      branch: "cogmo/cli-integration",
      worktreePath: "/workspace",
    },
    sessionId: null,
    containerId: null,
    allowPrivilegedRunc: false,
    plan: null,
    planApprovedAt: null,
    prMetadata: null,
    status: "queued",
    failureReason: null,
    resourceUsage: null,
    createdAt: new Date(),
  };
}

describe("ClaudeCodeBackend against cogmo-devbase:test", () => {
  it(
    "plan flow round-trips ExitPlanMode without wedging on the idle timer",
    async (ctx) => {
      if (!imagePresent) {
        ctx.skip();
        return;
      }
      const { sandbox } = await bootSandbox();
      const homeVolume = uniqueName("cogmo-task-home");
      homeVolumes.push(homeVolume);
      const taskId = "019e5000-0000-7000-8000-000000000001";

      const baseUrl = llmockUrlForContainer();
      const startedAt = Date.now();

      if (!workspaceTmp) throw new Error("workspaceTmp not initialized — beforeAll skipped?");

      const session = await sandbox.create({
        taskId,
        worktree: { type: "host-path", hostPath: workspaceTmp },
        homeVolume: { volumeName: homeVolume },
        image: DEVBASE_IMAGE,
        resourceLimits: RESOURCE_LIMITS,
        expiresAt: new Date(Date.now() + 5 * 60_000),
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-ant-fake",
          ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
          // Extended thinking carries signed payloads that llmock's
          // SSE-to-fixture collapse doesn't round-trip byte-for-byte; the
          // CLI's next-turn replay then 400s on "Invalid signature in
          // thinking block". Disabling at the source keeps the proxy
          // happy.
          MAX_THINKING_TOKENS: "0",
        },
      });

      const events: CodingEvent[] = [];
      try {
        for await (const event of new ClaudeCodeBackend().plan({
          task: makeTask(taskId),
          repo,
          container: session,
        })) {
          events.push(event);
        }
      } finally {
        await sandbox.deleteByTaskId(taskId);
      }

      const elapsedMs = Date.now() - startedAt;
      const kinds = events.map((e) => e.kind);

      // The wedge throws ExecTimeoutError out of the for-await loop, so
      // reaching this point already proves no idle timeout. The duration
      // bound catches a future "barely escaped" regression.
      expect(kinds).toContain("session_started");
      expect(kinds).toContain("complete");
      expect(elapsedMs).toBeLessThan(2 * 60_000);

      // permission_request must not escape runClaudePlan — its absence
      // here is what proves the inline auto-allow actually ran.
      expect(kinds).not.toContain("permission_request");

      // ExitPlanMode must actually have been called. Without this the
      // test would pass against any model that emits text and never
      // exits plan mode (the workspace-empty failure case).
      const toolCalls = events.flatMap((e) => (e.kind === "tool_call" ? [e.tool] : []));
      expect(toolCalls).toContain("ExitPlanMode");

      console.log(`claude-cli plan-mode events (${elapsedMs}ms): ${kinds.join(" → ")}`);
    },
    // Plan-mode run is ~15s; 3 min cap absorbs slow CI + image
    // cold-start while staying under the CLI's 5-min idle cap so the
    // wedge regression fails *this* test, not the CLI's internal timer.
    3 * 60_000,
  );
});
