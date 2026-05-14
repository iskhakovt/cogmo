/**
 * Narrow project-owned interface over the dockerode `Docker` class.
 *
 * The supervisor / runtime helpers only need ~7 methods on `Docker` plus a
 * handful of methods on the returned `Container`, `Image`, and `Exec`
 * objects. Declaring this facade explicitly:
 *
 *   1. Removes the `as unknown as Docker` cast scattered across test stubs —
 *      tests now build objects that structurally satisfy `DockerFacade`,
 *      no escape hatch needed.
 *   2. Documents the production surface of dockerode that Cogmo actually
 *      depends on, so a future SDK bump can be reasoned about without
 *      reading every call site.
 *   3. Keeps the door open for a future "wrap docker behind an HTTP-proxy
 *      adapter" abstraction without touching every consumer.
 *
 * Real `Docker` (from dockerode) structurally satisfies this interface —
 * `new Docker()` is assignable to `DockerFacade` with no cast at the boot
 * site (`src/index.ts`).
 *
 * Return types intentionally mirror dockerode's own shapes (`ContainerInfo`,
 * `ContainerCreateOptions`, `ExecCreateOptions`, etc.) — those types are
 * public API and stable enough to depend on; redefining them here would
 * just create busywork on every dockerode bump.
 */

import type { Duplex } from "node:stream";
import type Docker from "dockerode";

/**
 * Narrow shape capturing only what `assertRuntimeAvailable` reads from
 * `docker.info()` — the registered runtimes map. Dockerode's own
 * `info()` returns `Promise<any>`; declaring our slice here removes the
 * `info as { Runtimes?: ... }` cast at the call site.
 */
export interface DockerInfo {
  Runtimes?: Record<string, unknown>;
}

/**
 * Narrow shape capturing only what the supervisor reads from
 * `container.inspect()` — `State.Status` (lifecycle state) and
 * `HostConfig` (echoed for the proxy / cgroup wiring). The real
 * dockerode `ContainerInspectInfo` has dozens of fields we don't touch,
 * which would bleed into test fixture authoring.
 */
export interface ContainerInspect {
  State: { Status: string };
  HostConfig?: unknown;
}

/**
 * Narrow shape for `exec.inspect()` — we only read `ExitCode`.
 */
export interface ExecInspect {
  ExitCode: number | null;
}

export interface DockerContainer {
  readonly id: string;
  start(opts?: Docker.ContainerStartOptions): Promise<unknown>;
  stop(opts?: Docker.ContainerStopOptions): Promise<unknown>;
  inspect(opts?: Docker.ContainerInspectOptions): Promise<ContainerInspect>;
  remove(opts?: Docker.ContainerRemoveOptions): Promise<unknown>;
  kill(opts?: { signal?: string }): Promise<unknown>;
  exec(opts: Docker.ExecCreateOptions): Promise<DockerExec>;
}

export interface DockerExec {
  start(opts: Docker.ExecStartOptions): Promise<Duplex>;
  inspect(): Promise<ExecInspect>;
}

export interface DockerImage {
  inspect(): Promise<unknown>;
}

export interface DockerModem {
  followProgress(
    stream: NodeJS.ReadableStream,
    onFinished: (err: Error | null, output?: unknown[]) => void,
  ): void;
  demuxStream(
    source: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
  ): void;
}

export interface DockerFacade {
  info(): Promise<DockerInfo>;
  getContainer(id: string): DockerContainer;
  getImage(image: string): DockerImage;
  pull(image: string): Promise<NodeJS.ReadableStream>;
  listContainers(opts?: Docker.ContainerListOptions): Promise<Docker.ContainerInfo[]>;
  createContainer(opts: Docker.ContainerCreateOptions): Promise<DockerContainer>;
  modem: DockerModem;
}
