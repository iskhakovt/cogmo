/// <reference path="../../test/vitest.d.ts" />

/**
 * Bootstrap-level smoke for the daytona sandbox arm.
 *
 * Phase 3a + 3b.2.B + 3c.1 left the daytona path through `bootstrap()`
 * validated only at typecheck time — no test ever ran `bootstrapSandbox`
 * with a daytona-shape backend. This test wires `FakeDaytonaSandboxClient`
 * via `BootstrapOptions.sandboxClientOverride` and verifies that:
 *   - the override flows through `bootstrapSandbox` (sandbox + codingSandbox
 *     both resolve to the fake; daytona-shape capabilities surface),
 *   - `healthCheck` resolves on the wired client,
 *   - the coding orchestrator + cleanup-run-branch + orphan-sweep
 *     functions register in `bootstrapRuntime` (gated on `codingSandbox`),
 *   - the sandbox-reaper Inngest function does NOT register (gated on
 *     `sandboxDocker`, which is null for the override path because the
 *     reaper is local-docker-specific).
 *
 * What this test does NOT exercise — gap deferred to Phase 3c.6's
 * self-hosted-Daytona conformance suite: the tier-2 skill worker pool
 * against a daytona-shape backend (stdin/NDJSON, supervisor lifecycle,
 * worker recycle). Pool init is lazy now, so passing the daytona sandbox
 * through `bootstrap()` no longer triggers a tier-2 spawn — the pool is
 * only constructed on first tier-2 invocation, which this test doesn't
 * fire.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InngestFunction } from "inngest";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { bootstrap } from "../index.js";
import { FakeDaytonaSandboxClient } from "./daytona-sandbox-fake.js";

let bootstrapResult: Awaited<ReturnType<typeof bootstrap>>;
let fakeSandbox: FakeDaytonaSandboxClient;
let fakeBaseDir: string;

beforeAll(async () => {
  fakeBaseDir = mkdtempSync(join(tmpdir(), "cogmo-bootstrap-daytona-"));
  fakeSandbox = await FakeDaytonaSandboxClient.create({
    baseDir: fakeBaseDir,
    instanceId: "bootstrap-daytona-test",
  });

  // Tests share the integration tier's llmock — bootstrap dispatches LLM
  // calls through providerOverride, so any model name resolves to the
  // same Anthropic-shape fixture server. We don't actually fire a turn
  // here, but bootstrapCore validates the resolver wires up.
  const { AnthropicProvider } = await import("../llm/anthropic.js");
  const provider = new AnthropicProvider("test-key", inject("llmockBaseUrl"));

  bootstrapResult = await bootstrap({
    providerOverride: provider,
    sandboxClientOverride: fakeSandbox,
  });
}, 120_000);

afterAll(async () => {
  // Mirror `cogmo serve`'s teardown order from main.ts: adapters,
  // skill runner (holds the sandbox via its lazy pool), MCP
  // registry, sandbox handle, then the temp dir backing the fake.
  if (bootstrapResult) {
    for (const adapter of bootstrapResult.adapters) {
      await adapter.stop();
    }
    await bootstrapResult.skillRunner.shutdown();
    await bootstrapResult.mcpRegistry.stop();
    if (bootstrapResult.sandbox) {
      await bootstrapResult.sandbox.shutdown();
    }
  }
  if (fakeBaseDir) rmSync(fakeBaseDir, { recursive: true, force: true });
});

function functionIds(fns: ReadonlyArray<InngestFunction.Any>): string[] {
  return fns.map((f) => f.id());
}

describe("bootstrap with sandboxClientOverride (FakeDaytonaSandboxClient)", () => {
  it("resolves sandbox + codingSandbox to the override with daytona-shape capabilities", () => {
    expect(bootstrapResult.sandbox).toBe(fakeSandbox);
    expect(bootstrapResult.codingSandbox).toBe(fakeSandbox);
    // `randomUUID()` mints a v4 — version nibble pinned to `4` so a
    // future swap to v7 here would fail the test instead of silently
    // changing the wire format consumers see.
    expect(bootstrapResult.sandboxInstanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(bootstrapResult.sandboxDocker).toBeNull();
    expect(bootstrapResult.sandbox?.backendId).toBe("daytona-fake");
    expect(bootstrapResult.sandbox?.capabilities).toMatchObject({
      siblingContainers: "sandbox-internal",
      hostBindMount: false,
      customImage: true,
      volumes: "managed",
      workingTreeTransport: "git-remote",
      depsCacheSharing: "per-sandbox",
    });
  });

  it("healthCheck resolves on the wired sandbox", async () => {
    const result = await bootstrapResult.sandbox?.healthCheck();
    expect(result).toEqual({ ok: true, runtime: "daytona-fake" });
  });

  it("registers the coding orchestrator + verify + cleanup + orphan-sweep functions", () => {
    const ids = functionIds(bootstrapResult.functions);
    expect(ids).toContain("coding-task-start");
    expect(ids).toContain("coding-task-execute");
    expect(ids).toContain("coding-task-verify");
    expect(ids).toContain("coding-cleanup-run-branch");
    expect(ids).toContain("coding-orphan-run-branch-sweep-cron");
    expect(ids).toContain("coding-orphan-run-branch-sweep-repo");
  });

  it("does not register the local-docker sandbox-reaper (no docker handle)", () => {
    const ids = functionIds(bootstrapResult.functions);
    expect(ids).not.toContain("sandbox-reaper");
  });

  it("does not eagerly create the tier-2 worker pool — sandbox.create() never called at boot", () => {
    // Pool init is lazy — without a tier-2 invocation, no worker
    // should have been spawned. Pins the cost-saving contract:
    // cogmo serve on Daytona doesn't burn a billable sandbox at boot.
    expect(fakeSandbox.createCalls).toHaveLength(0);
  });
});
