import type { ContainerInfo } from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { DockerFacade } from "./docker-facade.js";
import { managedBindSources } from "./managed-binds.js";

type Mount = ContainerInfo["Mounts"][number];

function mountOf(type: string, source: string): Mount {
  return { Type: type, Source: source, Destination: "/in", Mode: "", RW: false, Propagation: "" };
}

function containerWith(mounts: Mount[]): ContainerInfo {
  const stub = mock<ContainerInfo>();
  Object.defineProperty(stub, "Mounts", { value: mounts, configurable: true });
  return stub;
}

describe("managedBindSources", () => {
  it("lists every cogmo.managed container, stopped ones included", async () => {
    const listContainers = vi.fn<DockerFacade["listContainers"]>(async () => []);

    await managedBindSources({ listContainers });

    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ["cogmo.managed=true"] },
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("collects the sources of their bind mounts, and nothing else", async () => {
    const listContainers = vi.fn<DockerFacade["listContainers"]>(async () => [
      containerWith([
        mountOf("bind", "/var/lib/cogmo/gates/d1"),
        mountOf("volume", "/var/lib/docker/volumes/home/_data"),
      ]),
      containerWith([mountOf("bind", "/var/lib/cogmo/askpass/t2")]),
      containerWith([]),
    ]);

    const sources = await managedBindSources({ listContainers });

    expect(sources._unsafeUnwrap()).toEqual(
      new Set(["/var/lib/cogmo/gates/d1", "/var/lib/cogmo/askpass/t2"]),
    );
  });

  it("errs once the daemon has not answered in 10 s, and aborts the request", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const listContainers = vi.fn<DockerFacade["listContainers"]>(
        (opts) =>
          new Promise((_resolve, reject) => {
            signal = opts?.abortSignal;
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );

      const pending = managedBindSources({ listContainers });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect((await pending)._unsafeUnwrapErr()).toBe(
        "the Docker daemon listed no containers within 10 s",
      );
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("errs, naming why, when the daemon cannot list them", async () => {
    const listContainers = vi.fn<DockerFacade["listContainers"]>(async () => {
      throw new Error("connect ECONNREFUSED /var/run/docker.sock");
    });

    const sources = await managedBindSources({ listContainers });

    expect(sources._unsafeUnwrapErr()).toContain("ECONNREFUSED");
  });
});
