/**
 * A `POST /containers/{id}/exec` exactly as the Docker CLI 29.9.3 sends it,
 * for `docker exec c1 id`. Recorded by pointing `DOCKER_HOST` at a
 * Unix-socket server that logged each request and answered `/_ping` with
 * API 1.51 and the container inspect as running. `docker exec -d` sends the
 * same body; this CLI sends `Detach` only on the start.
 */
export const DOCKER_CLI_EXEC_REQUEST = {
  method: "POST",
  path: "/v1.51/containers/c1/exec",
  headers: { "user-agent": "Docker-Client/29.9.3 (linux)", "content-type": "application/json" },
  body:
    '{"User":"","Privileged":false,"Tty":false,"AttachStdin":false,"AttachStderr":true,' +
    '"AttachStdout":true,"DetachKeys":"","Env":null,"WorkingDir":"","Cmd":["id"]}',
} as const;
