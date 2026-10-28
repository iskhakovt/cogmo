import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import type { DockerContainer, DockerFacade } from "./docker-facade.js";
import { killAndRemoveContainer } from "./kill-and-remove-container.js";

function daemonError(statusCode: number | undefined): Error {
  const error = new Error(`daemon ${statusCode ?? "?"}`);
  return statusCode === undefined ? error : Object.assign(error, { statusCode });
}

function stubDocker(): {
  docker: DockerFacade;
  container: ReturnType<typeof mock<DockerContainer>>;
} {
  const container = mock<DockerContainer>();
  container.kill.mockResolvedValue(undefined);
  container.remove.mockResolvedValue(undefined);
  const docker = mock<DockerFacade>();
  docker.getContainer.mockReturnValue(container);
  return { docker, container };
}

describe("killAndRemoveContainer", () => {
  it("kills with SIGTERM, then force-removes", async () => {
    const { docker, container } = stubDocker();
    const result = await killAndRemoveContainer(docker, "c1");
    expect(result.isOk()).toBe(true);
    expect(container.kill).toHaveBeenCalledWith({ signal: "SIGTERM" });
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it.each([304, 409, 404])("tolerates a %i on kill and still removes", async (code) => {
    const { docker, container } = stubDocker();
    container.kill.mockRejectedValue(daemonError(code));
    const result = await killAndRemoveContainer(docker, "c1");
    expect(result.isOk()).toBe(true);
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  it.each([404, 409])("tolerates a %i on remove", async (code) => {
    const { docker, container } = stubDocker();
    container.remove.mockRejectedValue(daemonError(code));
    const result = await killAndRemoveContainer(docker, "c1");
    expect(result.isOk()).toBe(true);
  });

  it("returns a kill daemon_error for any other kill status and does not remove", async () => {
    const { docker, container } = stubDocker();
    const error = daemonError(500);
    container.kill.mockRejectedValue(error);
    const result = await killAndRemoveContainer(docker, "c1");
    expect(result.isErr() && result.error).toEqual({
      kind: "daemon_error",
      op: "kill",
      statusCode: 500,
      error,
    });
    expect(container.remove).not.toHaveBeenCalled();
  });

  it("returns a remove daemon_error for any other remove status", async () => {
    const { docker, container } = stubDocker();
    const error = daemonError(500);
    container.remove.mockRejectedValue(error);
    const result = await killAndRemoveContainer(docker, "c1");
    expect(result.isErr() && result.error).toMatchObject({ op: "remove", statusCode: 500 });
  });

  it("reports an undefined statusCode for an error without one", async () => {
    const { docker, container } = stubDocker();
    container.kill.mockRejectedValue(daemonError(undefined));
    const result = await killAndRemoveContainer(docker, "c1");
    expect(result.isErr() && result.error).toMatchObject({ op: "kill", statusCode: undefined });
  });
});
