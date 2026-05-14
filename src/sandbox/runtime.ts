import type { DockerFacade } from "./docker-facade.js";

export type SandboxRuntime = "sysbox" | "runc";

/** Maps the env-level `SANDBOX_RUNTIME` ("sysbox" | "runc") to the actual Docker runtime name. */
export function dockerRuntimeName(r: SandboxRuntime): "sysbox-runc" | "runc" {
  return r === "sysbox" ? "sysbox-runc" : "runc";
}

/**
 * Confirm the configured runtime is registered on the host Docker daemon.
 * Throws — never falls back. The caller surfaces this at startup so
 * misconfiguration fails loudly rather than silently downgrading isolation.
 */
export async function assertRuntimeAvailable(
  docker: DockerFacade,
  runtime: SandboxRuntime,
): Promise<void> {
  const target = dockerRuntimeName(runtime);
  const info = await docker.info();
  const runtimes = info.Runtimes ?? {};
  if (!(target in runtimes)) {
    const registered = Object.keys(runtimes).join(", ") || "<none>";
    throw new Error(
      `SANDBOX_RUNTIME=${runtime} requires Docker runtime '${target}' to be registered, ` +
        `but the daemon only knows: ${registered}. Install sysbox via the .deb package, or ` +
        `set SANDBOX_RUNTIME=runc explicitly to opt into the unisolated runtime (dev/CI only).`,
    );
  }
}
