/// <reference path="../../../test/vitest.d.ts" />

/**
 * Real-Daytona end-to-end coverage for the PTY-backed `claude -p`
 * shutdown contract. The local-Docker counterpart
 * (`claude-cli.integration.test.ts`) exercises the dockerode-hijacked
 * stdin path; this file exercises the PTY + tmpfile-redirect path on
 * the Daytona backend, which has zero unit-substrate coverage because
 * the gap lives at the SDK↔WebSocket seam.
 *
 * Skipped by default — flip `describe.skip` to `describe` to run
 * manually. `describe.skip` (not `it.skip`) so the beforeAll's
 * `DaytonaSandboxClient.create` and snapshot-warm calls don't fire on
 * a default `pnpm test:integration`. The test exercises live Daytona
 * and Anthropic; there's no record/replay path because `DaytonaMock`
 * doesn't model the PTY WebSocket or `fs.uploadFile` endpoints this
 * code path uses.
 *
 * The test boots a real Daytona sandbox + the pinned `cogmo-devbase`
 * image, plants a workspace file, runs plan mode through the
 * production `ClaudeCodeBackend`, and asserts the wedge-regression
 * bound (`complete` under 4 min, well below the CLI's 5-min idle
 * backstop) along with `ExitPlanMode` being actually called.
 *
 * Cost per run: real Daytona compute (~3-5 min of one small sandbox)
 * + real Anthropic API tokens for one small plan turn. Worth the
 * spend when verifying any change to `src/sandbox/daytona/exec-pty.ts`
 * or the `claude -p` flag set in `src/agent/coding/claude.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaytonaSandboxClient } from "../../sandbox/daytona/client.js";
import type { CodingEvent } from "./backend.js";
import { ClaudeCodeBackend } from "./claude.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

const DEVBASE_IMAGE = process.env.COGMO_DEVBASE_IMAGE ?? "ghcr.io/iskhakovt/cogmo-devbase:latest";

let client: DaytonaSandboxClient | undefined;

beforeAll(async () => {
  // Defensive: today `describe.skip` is what keeps the integration
  // tier from firing this hook, and Vitest's documented behaviour is
  // that root hooks don't run when no tests in the file are
  // runnable. The skip-disables-beforeAll path is empirical, though
  // — if a future Vitest release tightens that, we don't want a
  // default integration run to error out trying to boot a real
  // Daytona client. Bail silently when the env hasn't been set up
  // for the manual-run workflow.
  if (!process.env.DAYTONA_API_KEY) return;
  const apiKey = process.env.DAYTONA_API_KEY;
  client = await DaytonaSandboxClient.create({
    apiKey,
    apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
    instanceId: "claude-cli-daytona-it",
    ...(process.env.DAYTONA_ORGANIZATION_ID && {
      organizationId: process.env.DAYTONA_ORGANIZATION_ID,
    }),
  });
  // Warm the snapshot up front so the test body doesn't pay the
  // ~5-15 min cold build inside its wedge-regression bound. Subsequent
  // task creates hit the warm cache in ~1s. `ensureImagePresent` is
  // idempotent and shares an in-flight promise per image.
  await client.ensureImagePresent(DEVBASE_IMAGE, {
    cpus: 1,
    memory_bytes: 2 * 1024 * 1024 * 1024,
    pids: 256,
    disk_bytes: 4 * 1024 * 1024 * 1024,
  });
}, 20 * 60_000);

afterAll(async () => {
  if (client) await client.shutdown();
});

const repo: CodingRepoRow = {
  id: "00000000-0000-7000-8000-000000000010",
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
    goal: "Read /workspace/greet.ts. Plan a single change: add a JSDoc comment to the greet function describing what it returns. Keep the plan to one short paragraph.",
    triggerSource: "user",
    triggerRef: null,
    backend: "claude",
    worktreeAssignment: {
      type: "host-path",
      branch: "cogmo/daytona-cli-integration",
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

const PLANTED_GREET_TS = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

describe.skip("ClaudeCodeBackend against real Daytona + PTY backend", () => {
  it(
    "plan flow runs the real CLI through PTY without wedging on stdin-EOF",
    async () => {
      if (!client) throw new Error("DaytonaSandboxClient was not initialized in beforeAll");
      const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY must be set to run this test");

      const taskId = `019e5100-0000-7000-8000-${Date.now().toString(16).padStart(12, "0")}`;
      const session = await client.create({
        taskId,
        image: DEVBASE_IMAGE,
        resourceLimits: {
          cpus: 1,
          memory_bytes: 2 * 1024 * 1024 * 1024,
          pids: 256,
          disk_bytes: 4 * 1024 * 1024 * 1024,
        },
        expiresAt: new Date(Date.now() + 10 * 60_000),
        env: {
          ANTHROPIC_API_KEY: anthropicApiKey,
          // Pin the model so token cost stays predictable across runs
          // and the CLI's behaviour matches what the local-docker
          // counterpart already exercises.
          ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
          // Extended thinking blocks carry signed payloads that complicate
          // resume; disable for parity with claude-cli.integration.test.ts.
          MAX_THINKING_TOKENS: "0",
        },
      });

      try {
        // Plant a file in /workspace — devbase ships with /workspace
        // owned by the `vscode` user (USER vscode + WORKDIR /workspace
        // in images/devbase/Dockerfile). Heredoc via shell `tee` so the
        // file content survives any bash quoting subtleties.
        const setup = await session.exec(
          [
            "bash",
            "-c",
            `cat > /workspace/greet.ts <<'COGMO_PLANT_EOF'\n${PLANTED_GREET_TS}COGMO_PLANT_EOF`,
          ],
          { workingDir: "/workspace" },
        );
        expect(setup.exitCode).toBe(0);

        const events: CodingEvent[] = [];
        const startedAt = Date.now();
        for await (const event of new ClaudeCodeBackend().plan({
          task: makeTask(taskId),
          repo,
          container: session,
        })) {
          events.push(event);
        }
        const elapsedMs = Date.now() - startedAt;
        const kinds = events.map((e) => e.kind);

        // Reaching this point proves the PTY-backed shutdown contract
        // is intact: stdin EOF (delivered as the redirected file's EOF
        // inside the PTY shell) propagated to claude, which then
        // emitted `result` and let the PTY tear down. Without that
        // path, the CLI's 5-min idle backstop would throw
        // `ExecTimeoutError` out of the for-await loop.
        expect(kinds).toContain("session_started");
        expect(kinds).toContain("complete");

        // Wedge-regression bound. The wedge symptom is "sits on the
        // 5-min idle timer"; pinning to 4 min keeps the failure mode
        // "wedge detected" rather than "CI was slow".
        expect(elapsedMs).toBeLessThan(4 * 60_000);

        const toolCalls = events.flatMap((e) => (e.kind === "tool_call" ? [e.tool] : []));
        expect(toolCalls).toContain("ExitPlanMode");

        console.log(`claude-cli daytona plan-mode events (${elapsedMs}ms): ${kinds.join(" → ")}`);
      } finally {
        await client.deleteByTaskId(taskId);
      }
    },
    // Outer cap sits above the CLI's 5-min idle backstop so a wedge
    // fails as a real test timeout rather than the CLI's internal
    // timer. 10 min absorbs the additional latency of a real Daytona
    // sandbox spin-up against a warm snapshot.
    10 * 60_000,
  );
});
