/**
 * A fake Docker daemon on a Unix socket, for tests of the socket proxy. It
 * records every request it receives and answers through a swappable
 * responder; `dockerApi` builds one that answers the lookups a container
 * create needs.
 */

import * as http from "node:http";

export interface FakeDaemonRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type FakeDaemonResponder = (
  req: FakeDaemonRequest,
  res: http.ServerResponse,
  raw: http.IncomingMessage,
) => void;

export interface FakeDockerDaemon {
  readonly socketPath: string;
  /** Every request received so far, in arrival order. */
  requests(): ReadonlyArray<FakeDaemonRequest>;
  setResponder(responder: FakeDaemonResponder): void;
  close(): Promise<void>;
}

export async function startFakeDockerDaemon(
  socketPath: string,
  responder: FakeDaemonResponder,
): Promise<FakeDockerDaemon> {
  const received: FakeDaemonRequest[] = [];
  let current = responder;
  const server = http.createServer((raw, res) => {
    const chunks: Buffer[] = [];
    raw.on("data", (c: Buffer) => chunks.push(c));
    raw.on("end", () => {
      const req: FakeDaemonRequest = {
        method: raw.method ?? "",
        url: raw.url ?? "",
        headers: raw.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(req);
      current(req, res, raw);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests: () => [...received],
    setResponder: (next) => {
      current = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface FakeImage {
  id: string;
  env: ReadonlyArray<string>;
}

export interface DockerApiOptions {
  /** Images the daemon has, by the reference a client inspects them under. */
  images: ReadonlyMap<string, FakeImage>;
  /** `GET /version` → `Arch`. */
  arch: string;
  /** `GET /networks/bridge` → the IPv4 gateway. */
  bridgeGateway: string;
}

/**
 * Answers `GET /version`, `GET /images/{name}/json` (404 for an unknown
 * image), `GET /networks/bridge`, `POST /containers/create` (201) and
 * `POST /containers/{id}/exec` (201). Everything else gets `200 {}`.
 */
export function dockerApi(opts: DockerApiOptions): FakeDaemonResponder {
  return (req, res) => {
    const path = req.url.split("?")[0] ?? "";
    const image = /^\/(?:v[\d.]+\/)?images\/(.+)\/json$/.exec(path);
    if (req.method === "GET" && image?.[1] !== undefined) {
      const found = opts.images.get(decodeURIComponent(image[1]));
      if (found === undefined) {
        respondJson(res, 404, { message: `No such image: ${image[1]}` });
        return;
      }
      respondJson(res, 200, { Id: found.id, Config: { Env: found.env } });
      return;
    }
    if (req.method === "GET" && /^\/(?:v[\d.]+\/)?version$/.test(path)) {
      respondJson(res, 200, {
        Version: "29.0.0",
        ApiVersion: "1.52",
        Os: "linux",
        Arch: opts.arch,
      });
      return;
    }
    if (req.method === "GET" && /^\/(?:v[\d.]+\/)?networks\/bridge$/.test(path)) {
      respondJson(res, 200, {
        Name: "bridge",
        IPAM: { Config: [{ Subnet: "172.17.0.0/16", Gateway: opts.bridgeGateway }] },
      });
      return;
    }
    if (req.method === "POST" && /^\/(?:v[\d.]+\/)?containers\/create$/.test(path)) {
      respondJson(res, 201, { Id: "child-container-1", Warnings: [] });
      return;
    }
    if (req.method === "POST" && /^\/(?:v[\d.]+\/)?containers\/[^/]+\/exec$/.test(path)) {
      respondJson(res, 201, { Id: "exec-1" });
      return;
    }
    respondJson(res, 200, {});
  };
}

export interface SocketResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One HTTP/1.1 request over a Unix socket, without keep-alive. */
export function requestOverSocket(
  socketPath: string,
  req: { method: string; path: string; body?: string; headers?: Record<string, string> },
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        socketPath,
        method: req.method,
        path: req.path,
        agent: new http.Agent({ keepAlive: false }),
        headers: {
          "content-type": "application/json",
          connection: "close",
          ...req.headers,
          ...(req.body !== undefined && { "content-length": String(Buffer.byteLength(req.body)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    if (req.body !== undefined) outgoing.write(req.body);
    outgoing.end();
  });
}
