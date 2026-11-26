/**
 * Requests exactly as testcontainers-node 12.2.1 (over dockerode 5.0.1 and
 * docker-modem 5.0.7) sends them to an existing container, recorded the way
 * `testcontainers-create-request.ts` was: `DOCKER_HOST` pointed at a
 * Unix-socket server that logged each request and forwarded it to a Docker
 * 29.9.3 daemon, with `TESTCONTAINERS_RYUK_DISABLED=true`, while
 *
 * ```ts
 * await TestContainers.exposeHostPorts(45999);
 * const c = await new GenericContainer("alpine:3")
 *   .withCommand(["sh", "-c", "echo ready; sleep 300"])
 *   .withExposedPorts(8080)
 *   .withCopyContentToContainer([{ content: "hello", target: "/tmp/hello.txt" }])
 *   .withHealthCheck({ test: ["CMD-SHELL", "true"], interval: 1000, timeout: 1000, retries: 3, startPeriod: 0 })
 *   .withWaitStrategy(Wait.forAll([Wait.forLogMessage("ready"), Wait.forHealthCheck()]))
 *   .start();
 * await c.exec(["cat", "/tmp/hello.txt"]);
 * await c.copyArchiveFromContainer("/tmp/hello.txt");
 * await c.stop();
 * ```
 *
 * ran. Every container request names the container by the full id from its
 * create's 201, never by name or prefix, and sends no API version prefix.
 * The client sends a `Connection: keep-alive` header with each, left out
 * here. Neither the client nor its wait strategies call `/containers/{id}/wait`
 * or `/events`: the log wait follows `logs`, and the health-check wait polls
 * the inspect.
 */

const CONTAINER = "477cdbd59ea8e4d2fe700c1a771344e7ee9162a6ad10ccbee9f81ddc7b1fe880";
const USER_AGENT = { "user-agent": "tc-node/12.2.1" } as const;

/**
 * The requests on the started container that need no body policy, in the
 * order the run sent them. `PUT /archive` carried a 2048-byte tar with
 * `Transfer-Encoding: chunked`; the exec create and inspect are in
 * `TESTCONTAINERS_EXEC_REQUESTS`.
 */
export const TESTCONTAINERS_CONTAINER_REQUESTS = [
  {
    label: "start",
    method: "POST",
    path: `/containers/${CONTAINER}/start`,
    headers: USER_AGENT,
    body: undefined,
  },
  {
    label: "inspect",
    method: "GET",
    path: `/containers/${CONTAINER}/json`,
    headers: USER_AGENT,
    body: undefined,
  },
  {
    label: "log wait",
    method: "GET",
    path: `/containers/${CONTAINER}/logs?follow=true&stdout=true&stderr=true&tail=-1&since=0`,
    headers: USER_AGENT,
    body: undefined,
  },
  {
    label: "archive read",
    method: "GET",
    path: `/containers/${CONTAINER}/archive?path=%2Ftmp%2Fhello.txt`,
    headers: USER_AGENT,
    body: undefined,
  },
  {
    label: "stop",
    method: "POST",
    path: `/containers/${CONTAINER}/stop?t=0`,
    headers: { ...USER_AGENT, "content-type": "application/json" },
    body: '{"t":0}',
  },
  {
    label: "remove",
    method: "DELETE",
    path: `/containers/${CONTAINER}?v=true`,
    headers: USER_AGENT,
    body: undefined,
  },
] as const;

/**
 * `exec(["cat", "/tmp/hello.txt"])`: the create, and the inspect that reads
 * the exit code, which names the exec create's 201 `Id` as `{id}`. Between
 * them the client starts the exec with a POST that carries no `Upgrade`
 * header and the 41-byte JSON body `{"stdin":true,"Detach":false,"Tty":false}`.
 */
export const TESTCONTAINERS_EXEC_REQUESTS = {
  create: {
    method: "POST",
    path: `/containers/${CONTAINER}/exec`,
    headers: { ...USER_AGENT, "content-type": "application/json" },
    body: '{"Cmd":["cat","/tmp/hello.txt"],"AttachStdout":true,"AttachStderr":true}',
  },
  inspect: { method: "GET", path: "/exec/{id}/json", headers: USER_AGENT },
} as const;

/**
 * The port forwarder's connect of a new container to its own network, the
 * default `bridge`, which it names by the id it read from the sshd
 * container's inspect (`8410…` on the recording daemon).
 */
export const TESTCONTAINERS_BRIDGE_CONNECT_REQUEST = {
  method: "POST",
  path: "/networks/8410490959e2f636b23cdb92ee4452b0e991c0ac62ff8f4011291227641c721c/connect",
  headers: { ...USER_AGENT, "content-type": "application/json" },
  body: `{"Container":"${CONTAINER}","EndpointConfig":{"Aliases":[]}}`,
} as const;

/**
 * `client.image.pull(ImageName.fromString("busybox:1.36.1"))`, recorded the
 * same way against an image the daemon did not have. docker-modem sends a
 * POST's options as the query and again as a JSON body; the empty
 * `authconfig` and `platform` keys are options testcontainers left unset.
 */
export const TESTCONTAINERS_PULL_REQUEST = {
  method: "POST",
  path: "/images/create?authconfig=&platform=&fromImage=busybox&tag=1.36.1",
  headers: { ...USER_AGENT, "content-type": "application/json" },
  body: '{"fromImage":"busybox","tag":"1.36.1"}',
} as const;
