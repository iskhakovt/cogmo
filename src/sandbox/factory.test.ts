import type Docker from "dockerode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSandboxBackend } from "./factory.js";

// The factory thinly dispatches to either `LocalDockerSandboxClient.create`
// or `DaytonaSandboxClient.create`. We mock both at the module boundary
// and assert the right one runs, with the right deps threaded through.
const localDockerCreate = vi.fn();
const daytonaCreate = vi.fn();

vi.mock("./supervisor.js", () => ({
  LocalDockerSandboxClient: {
    create: (...args: unknown[]) => localDockerCreate(...args),
  },
}));

vi.mock("./daytona/index.js", () => ({
  DaytonaSandboxClient: {
    create: (...args: unknown[]) => daytonaCreate(...args),
  },
}));

beforeEach(() => {
  localDockerCreate.mockReset();
  daytonaCreate.mockReset();
});

describe("createSandboxBackend", () => {
  describe("local-docker", () => {
    it("threads docker / store / runInTx / runtime / instanceId / proxy / askpassBaseDir", async () => {
      localDockerCreate.mockResolvedValue({ backendId: "local-docker" });
      const docker = {} as Docker;
      const store = { kind: "store" };
      const runInTx = vi.fn();
      const proxy = { kind: "proxy" };
      await createSandboxBackend({
        backend: "local-docker",
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub for factory dispatch test
        docker: docker as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub
        store: store as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub
        runInTx: runInTx as any,
        runtime: "runc",
        instanceId: "inst-1",
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub
        proxy: proxy as any,
        askpassBaseDir: "/run/cogmo/askpass",
      });
      expect(localDockerCreate).toHaveBeenCalledTimes(1);
      const callArg = localDockerCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).toMatchObject({
        docker,
        store,
        runInTx,
        runtime: "runc",
        instanceId: "inst-1",
        proxy,
        askpassBaseDir: "/run/cogmo/askpass",
      });
      expect(daytonaCreate).not.toHaveBeenCalled();
    });

    it("omits proxy + askpassBaseDir from the call when not supplied", async () => {
      localDockerCreate.mockClear();
      localDockerCreate.mockResolvedValue({ backendId: "local-docker" });
      await createSandboxBackend({
        backend: "local-docker",
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub
        docker: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub
        store: {} as any,
        // biome-ignore lint/suspicious/noExplicitAny: minimal stub
        runInTx: vi.fn() as any,
        runtime: "runc",
        instanceId: "inst-2",
      });
      const callArg = localDockerCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      // exactOptionalPropertyTypes: undefined is NOT the same as
      // missing — these keys must be absent.
      expect(callArg).not.toHaveProperty("proxy");
      expect(callArg).not.toHaveProperty("askpassBaseDir");
    });
  });

  describe("daytona", () => {
    it("threads apiKey + instanceId + optional apiUrl + organizationId", async () => {
      daytonaCreate.mockResolvedValue({ backendId: "daytona" });
      await createSandboxBackend({
        backend: "daytona",
        apiKey: "secret-abc",
        instanceId: "inst-3",
        apiUrl: "https://daytona.example.com/api",
        organizationId: "org-xyz",
      });
      expect(daytonaCreate).toHaveBeenCalledTimes(1);
      expect(daytonaCreate.mock.calls[0]?.[0]).toMatchObject({
        apiKey: "secret-abc",
        instanceId: "inst-3",
        apiUrl: "https://daytona.example.com/api",
        organizationId: "org-xyz",
      });
      expect(localDockerCreate).not.toHaveBeenCalled();
    });

    it("omits apiUrl + organizationId when not supplied (SDK falls back to defaults)", async () => {
      daytonaCreate.mockClear();
      daytonaCreate.mockResolvedValue({ backendId: "daytona" });
      await createSandboxBackend({
        backend: "daytona",
        apiKey: "secret-def",
        instanceId: "inst-4",
      });
      const callArg = daytonaCreate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArg).not.toHaveProperty("apiUrl");
      expect(callArg).not.toHaveProperty("organizationId");
    });
  });
});
