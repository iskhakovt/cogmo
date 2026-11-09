import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { runBootChecks } from "./boot/checks.js";
import { bootstrapCore } from "./boot/core.js";
import { bootstrapRuntime } from "./boot/runtime.js";
import { bootstrapSandbox } from "./boot/sandbox.js";
import { bootstrapSkillRunner, reconcileSkillsMirrorAtBoot } from "./boot/skills.js";
import type { CoreDeps, RuntimeDeps, SandboxDeps, SkillRunnerHandle } from "./boot/stages.js";
import { bootstrap } from "./index.js";

vi.mock("./boot/checks.js", () => ({
  checkInngestAuth: vi.fn(),
  checkS3Bucket: vi.fn(),
  independentProbeContext: vi.fn(),
  runBootChecks: vi.fn(),
}));
vi.mock("./boot/core.js", () => ({ bootstrapCore: vi.fn() }));
vi.mock("./boot/memory.js", () => ({ verifyHindsight: vi.fn() }));
vi.mock("./boot/runtime.js", () => ({ bootstrapRuntime: vi.fn() }));
vi.mock("./boot/sandbox.js", () => ({ bootstrapSandbox: vi.fn() }));
vi.mock("./boot/skills.js", () => ({
  bootstrapSkillRunner: vi.fn(),
  reconcileSkillsMirrorAtBoot: vi.fn(),
}));

describe("bootstrap", () => {
  it("starts the runtime only once the skills remote's boot reconcile has finished", async () => {
    vi.mocked(bootstrapCore).mockResolvedValue(mock<CoreDeps>());
    vi.mocked(runBootChecks).mockResolvedValue(undefined);
    vi.mocked(bootstrapSandbox).mockResolvedValue(mock<SandboxDeps>());
    vi.mocked(bootstrapSkillRunner).mockResolvedValue(mock<SkillRunnerHandle>());
    vi.mocked(bootstrapRuntime).mockResolvedValue(mock<RuntimeDeps>());
    let finishReconcile: () => void = () => {};
    vi.mocked(reconcileSkillsMirrorAtBoot).mockReturnValue(
      new Promise<void>((resolve) => {
        finishReconcile = resolve;
      }),
    );

    const booted = bootstrap();
    await vi.waitFor(() => expect(reconcileSkillsMirrorAtBoot).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bootstrapRuntime).not.toHaveBeenCalled();

    finishReconcile();
    await booted;
    expect(bootstrapRuntime).toHaveBeenCalledTimes(1);
  });
});
