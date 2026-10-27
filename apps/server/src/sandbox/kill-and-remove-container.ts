import { err, ok, type Result } from "neverthrow";
import type { DockerFacade } from "./docker-facade.js";

/** The daemon refused a kill or remove with something other than "already gone". */
export interface DaemonError {
  kind: "daemon_error";
  op: "kill" | "remove";
  statusCode: number | undefined;
  error: unknown;
}

/**
 * Kill, then force-remove, a container; tolerant of the daemon having got
 * there first. 304/409/404 on kill and 409/404 on remove all mean "already
 * stopped, being removed, or gone" — the reaper and a cascade can race on
 * the same id. Anything else is a `DaemonError` for the caller to log or
 * surface.
 */
export async function killAndRemoveContainer(
  docker: DockerFacade,
  dockerId: string,
): Promise<Result<void, DaemonError>> {
  const c = docker.getContainer(dockerId);
  try {
    await c.kill({ signal: "SIGTERM" });
  } catch (error) {
    const statusCode = statusCodeOf(error);
    if (statusCode !== 304 && statusCode !== 409 && statusCode !== 404) {
      return err({ kind: "daemon_error", op: "kill", statusCode, error });
    }
  }
  try {
    await c.remove({ force: true });
  } catch (error) {
    const statusCode = statusCodeOf(error);
    if (statusCode !== 404 && statusCode !== 409) {
      return err({ kind: "daemon_error", op: "remove", statusCode, error });
    }
  }
  return ok(undefined);
}

/** The HTTP status dockerode attaches to a daemon error, if the error carries one. */
export function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    return typeof error.statusCode === "number" ? error.statusCode : undefined;
  }
  return undefined;
}
