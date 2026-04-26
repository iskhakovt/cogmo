import { describe, expect, it, vi } from "vitest";
import { assertRuntimeAvailable, dockerRuntimeName } from "./runtime.js";

function fakeDocker(runtimes: Record<string, unknown>) {
  return {
    info: vi.fn().mockResolvedValue({ Runtimes: runtimes }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock for assertRuntimeAvailable
  } as any;
}

describe("dockerRuntimeName", () => {
  it("maps sysbox → sysbox-runc", () => {
    expect(dockerRuntimeName("sysbox")).toBe("sysbox-runc");
  });
  it("maps runc → runc", () => {
    expect(dockerRuntimeName("runc")).toBe("runc");
  });
});

describe("assertRuntimeAvailable", () => {
  it("passes when the configured runtime is registered", async () => {
    const docker = fakeDocker({ runc: {}, "sysbox-runc": {} });
    await expect(assertRuntimeAvailable(docker, "sysbox")).resolves.toBeUndefined();
    await expect(assertRuntimeAvailable(docker, "runc")).resolves.toBeUndefined();
  });

  it("throws with a useful message when sysbox-runc is missing", async () => {
    const docker = fakeDocker({ runc: {} });
    await expect(assertRuntimeAvailable(docker, "sysbox")).rejects.toThrow(
      /SANDBOX_RUNTIME=sysbox.*sysbox-runc.*runc/s,
    );
  });

  it("throws when no runtimes at all are reported", async () => {
    const docker = fakeDocker({});
    await expect(assertRuntimeAvailable(docker, "runc")).rejects.toThrow(/<none>/);
  });

  it("propagates docker.info() failures", async () => {
    const docker = {
      info: vi.fn().mockRejectedValue(new Error("docker daemon unreachable")),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    } as any;
    await expect(assertRuntimeAvailable(docker, "runc")).rejects.toThrow(/unreachable/);
  });
});
