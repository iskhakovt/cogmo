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
    "plan flow runs the real CLI to completion with ExitPlanMode in the tool calls",
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

      // The wrapper closes stdin immediately after writing the prompt;
      // the CLI's 5-min idle timer would throw `ExecTimeoutError` out of
      // the for-await loop if stdin EOF stopped propagating cleanly, so
      // reaching this point proves the shutdown contract is intact.
      expect(kinds).toContain("session_started");
      expect(kinds).toContain("complete");

      // Wedge-regression bound. Healthy replay finishes well under a
      // minute; sitting on the CLI's 5-min idle backstop would report as
      // a slow CI build under the outer `6 * 60_000` only. Pinning to
      // 4 min keeps the failure mode "wedge detected", not "CI was slow".
      expect(elapsedMs).toBeLessThan(4 * 60_000);

      // ExitPlanMode must actually have been called. Without this the
      // test would pass against any model that emits text and never
      // exits plan mode (the workspace-empty failure case).
      const toolCalls = events.flatMap((e) => (e.kind === "tool_call" ? [e.tool] : []));
      expect(toolCalls).toContain("ExitPlanMode");

      console.log(`claude-cli plan-mode events (${elapsedMs}ms): ${kinds.join(" → ")}`);
    },
    // CLI's 5-min idle cap is the wedge-regression backstop; outer
    // timeout sits above that so a wedge fails as a real test timeout
    // rather than the CLI's internal timer. 6 min absorbs CI cold-start
    // + image pull + the actual plan run.
    6 * 60_000,
  );

  // Execute-mode shutdown contract: `claude --resume <sid>` must honour
  // the same stdin-EOF shutdown signal as plan mode and emit `complete`
  // without sitting on the 5-min idle timer. Plan runs first to mint a
  // real session id; execute resumes it. Both phases run against
  // recorded llmock fixtures — re-record with `RECORD=1` if the CLI
  // version bumps and the request bodies drift.
  it(
    "execute flow resumes a real session and completes without wedging on close-stdin",
    async (ctx) => {
      if (!imagePresent) {
        ctx.skip();
        return;
      }
      const { sandbox } = await bootSandbox();
      const homeVolume = uniqueName("cogmo-task-home");
      homeVolumes.push(homeVolume);
      const taskId = "019e5000-0000-7000-8000-000000000002";

      const baseUrl = llmockUrlForContainer();

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
          MAX_THINKING_TOKENS: "0",
        },
      });

      // Plan phase first to mint a session id. The CLI persists the
      // session under the home volume, which the execute leg resumes
      // by pointing `--resume` at the captured id.
      const backend = new ClaudeCodeBackend();
      let sessionId: string | undefined;
      const planEvents: CodingEvent[] = [];
      try {
        for await (const event of backend.plan({
          task: makeTask(taskId),
          repo,
          container: session,
        })) {
          planEvents.push(event);
          if (event.kind === "session_started") sessionId = event.sessionId;
        }
      } finally {
        // Keep the sandbox alive for the execute leg — only sweep on test
        // teardown via the `afterAll` instance-id cleanup.
      }
      if (!sessionId) throw new Error("plan phase did not emit session_started");

      const executeTask = { ...makeTask(taskId), sessionId };
      const startedAt = Date.now();
      const executeEvents: CodingEvent[] = [];
      try {
        for await (const event of backend.execute(
          { task: executeTask, repo, container: session },
          sessionId,
        )) {
          executeEvents.push(event);
        }
      } finally {
        await sandbox.deleteByTaskId(taskId);
      }

      const elapsedMs = Date.now() - startedAt;
      const kinds = executeEvents.map((e) => e.kind);

      // Same shutdown-contract pin as the plan test: reaching this point
      // proves stdin EOF propagated and the CLI didn't sit on its idle
      // timer. session_started fires from `--resume`'s init event.
      expect(kinds).toContain("session_started");
      expect(kinds).toContain("complete");

      // Wedge-regression bound. See the plan test for the rationale —
      // 4 min stays well under the CLI's 5-min idle backstop.
      expect(elapsedMs).toBeLessThan(4 * 60_000);

      // Execute mode should emit at least one tool_call against the
      // planted greet.ts — even a trivial JSDoc addition routes
      // through Read + Edit.
      const toolCalls = executeEvents.flatMap((e) => (e.kind === "tool_call" ? [e.tool] : []));
      expect(toolCalls.length).toBeGreaterThan(0);

      console.log(`claude-cli execute-mode events (${elapsedMs}ms): ${kinds.join(" → ")}`);
    },
    6 * 60_000,
  );
});
