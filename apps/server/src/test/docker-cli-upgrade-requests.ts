/**
 * The upgrades the Docker CLI 29.9.3 sends, byte for byte, recorded by
 * pointing `DOCKER_HOST` at a Unix-socket server that logged each
 * connection and forwarded it to a Docker 29.9.3 daemon: the exec start of
 * `docker exec -it c1 sh -c '…'` and the attach of `docker attach c1`. Both
 * name `Upgrade: tcp` and frame their body by `Content-Length`; `docker exec
 * -i` sends the same start with `"Tty":false` (28 bytes). The daemon
 * answered each with `101 UPGRADED`.
 */

const CLI_HEADERS = "Host: api.moby.localhost\r\nUser-Agent: Docker-Client/29.9.3 (linux)\r\n";

/** `docker exec -it`'s start of the exec `execId`. */
export function dockerCliExecStart(execId: string): string {
  return (
    `POST /v1.56/exec/${execId}/start HTTP/1.1\r\n${CLI_HEADERS}` +
    "Content-Length: 27\r\nConnection: Upgrade\r\nContent-Type: application/json\r\nUpgrade: tcp\r\n\r\n" +
    '{"Detach":false,"Tty":true}'
  );
}

/** `docker attach`'s attach to `container`. */
export function dockerCliAttach(container: string): string {
  return (
    `POST /v1.56/containers/${container}/attach?stderr=1&stdin=1&stdout=1&stream=1 HTTP/1.1\r\n` +
    `${CLI_HEADERS}Content-Length: 0\r\nConnection: Upgrade\r\nContent-Type: text/plain\r\nUpgrade: tcp\r\n\r\n`
  );
}
