/**
 * A fake Docker daemon on a Unix socket, for tests of the socket proxy. It
 * records every request it receives and answers through a swappable
 * responder; `dockerApi` builds one that answers the lookups a container
 * create needs and resolves container, network and exec refs the way the
 * daemon does.
 */

import { createHash } from "node:crypto";
import * as http from "node:http";
import type { Duplex } from "node:stream";
import { match } from "ts-pattern";

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
  /** Every request received so far, in arrival order, recorded once its body ended. */
  requests(): ReadonlyArray<FakeDaemonRequest>;
  /** Every request line whose headers arrived, as `METHOD url`, whether or not its body ended. */
  started(): ReadonlyArray<string>;
  /** Connections accepted so far. */
  connections(): number;
  /** Every upgrade received, in arrival order, once its body ended. */
  upgrades(): ReadonlyArray<FakeUpgrade>;
  /** Answer no upgrade from now on: record each and hold its connection open. */
  holdUpgrades(): void;
  /**
   * From now on, a switched upgrade writes `output` after its `101` and
   * ends, without waiting for the client to end its side.
   */
  finishUpgrades(output: string): void;
  setResponder(responder: FakeDaemonResponder): void;
  close(): Promise<void>;
}

export interface FakeUpgrade {
  url: string;
  /** `101`, a refusal (200 or 400), or no answer (`holdUpgrades`). */
  answer: "switched" | "refused" | "held";
  /**
   * What the client sent after the request's body, as latin1, one character
   * per octet; after a refusal, only what came with the request.
   */
  received: string;
  closed: boolean;
}

export async function startFakeDockerDaemon(
  socketPath: string,
  responder: FakeDaemonResponder,
): Promise<FakeDockerDaemon> {
  const received: FakeDaemonRequest[] = [];
  const started: string[] = [];
  let connections = 0;
  const upgrades: FakeUpgrade[] = [];
  const upgradeSockets = new Set<Duplex>();
  let holding = false;
  let finalOutput: string | null = null;
  let current = responder;
  const server = http.createServer((raw, res) => {
    started.push(`${raw.method} ${raw.url}`);
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
  server.on("connection", () => {
    connections += 1;
  });
  // An upgrade is answered as the daemon answers exec start: `101` (with the
  // `Sec-WebSocket-Accept` a WebSocket handshake needs, for one), then a
  // stream that records what the client sends and, once the client ends its
  // side, writes `late-output` and ends; or, for a detached start or a body
  // that is not JSON, a plain 200 or 400 and no switch. After a refusal the
  // connection is kept open and parsed as HTTP again, unless the request's
  // `Connection` holds `close`, as Go's server does. A held upgrade gets no
  // answer, and its connection stays open, recording what the client sends,
  // until the client ends its side, when the daemon closes it.
  server.on("upgrade", (raw: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    started.push(`${raw.method} ${raw.url}`);
    readUpgradeBody(raw, head)
      .then(({ body, rest }) => {
        received.push({ method: raw.method ?? "", url: raw.url ?? "", headers: raw.headers, body });
        const answer: FakeUpgradeAnswer = holding ? { kind: "held" } : upgradeAnswer(body);
        const upgrade: FakeUpgrade = {
          url: raw.url ?? "",
          answer: answer.kind,
          received: rest.toString("latin1"),
          closed: false,
        };
        upgrades.push(upgrade);
        upgradeSockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => {
          upgrade.closed = true;
        });
        const record = (chunk: Buffer) => {
          upgrade.received += chunk.toString("latin1");
        };
        match(answer)
          .with({ kind: "held" }, () => {
            socket.on("data", record);
            socket.once("end", () => socket.end());
          })
          .with({ kind: "switched" }, () => {
            socket.on("data", record);
            socket.write(switchingResponse(raw.headers));
            if (finalOutput !== null) {
              socket.end(finalOutput);
              return;
            }
            // A client that ended its side before the switch has already been read to its end.
            const endStream = () => socket.end("late-output\n");
            if (socket.readableEnded) endStream();
            else socket.on("end", endStream);
          })
          .with({ kind: "refused" }, ({ status, body: refusal }) => {
            const reply = JSON.stringify(refusal);
            const closes = /(^|,)\s*close\s*(,|$)/i.test(raw.headers.connection ?? "");
            socket.write(
              `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
                `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(reply)}\r\n` +
                `${closes ? "Connection: close\r\n" : ""}\r\n${reply}`,
            );
            if (closes) {
              socket.end();
              return;
            }
            if (rest.length > 0) socket.unshift(rest);
            server.emit("connection", socket);
          })
          .exhaustive();
      })
      .catch(() => {
        // A client that hung up mid-body: there is no one to answer.
        socket.destroy();
      });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    requests: () => [...received],
    started: () => [...started],
    connections: () => connections,
    upgrades: () => upgrades.map((upgrade) => ({ ...upgrade })),
    holdUpgrades: () => {
      holding = true;
    },
    finishUpgrades: (output) => {
      finalOutput = output;
    },
    setResponder: (next) => {
      current = next;
    },
    close: async () => {
      for (const socket of upgradeSockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The upgrade's body and the bytes after it. Node parses a `Content-Length`
 * body into the request even when it asks to upgrade, and hands over only
 * what follows the body as `head`.
 */
async function readUpgradeBody(
  raw: http.IncomingMessage,
  head: Buffer,
): Promise<{ body: string; rest: Buffer }> {
  const chunks: Buffer[] = [];
  for await (const chunk of raw) chunks.push(Buffer.from(chunk));
  return { body: Buffer.concat(chunks).toString("utf8"), rest: head };
}

type FakeUpgradeAnswer =
  | { kind: "held" }
  | { kind: "switched" }
  | { kind: "refused"; status: number; body: unknown };

/** How the daemon answers an exec start upgrade with `body`: it switches, or refuses a detached start or a body that is not JSON. */
function upgradeAnswer(body: string): FakeUpgradeAnswer {
  if (body === "") return { kind: "switched" };
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" &&
      parsed !== null &&
      "Detach" in parsed &&
      parsed.Detach === true
      ? { kind: "refused", status: 200, body: {} }
      : { kind: "switched" };
  } catch {
    return { kind: "refused", status: 400, body: { message: "invalid JSON: unexpected EOF" } };
  }
}

/** RFC 6455's key suffix for `Sec-WebSocket-Accept`. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `101` the daemon switches with: a WebSocket handshake's for `Upgrade: websocket`, `tcp` otherwise. */
function switchingResponse(headers: http.IncomingHttpHeaders): string {
  const key = headers["sec-websocket-key"];
  if (headers.upgrade?.toLowerCase() !== "websocket" || key === undefined) {
    return "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n";
  }
  const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
  return (
    "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

export function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface FakeImage {
  id: string;
  env: ReadonlyArray<string>;
}

export interface FakeContainer {
  /** The full 64-character hex id. */
  id: string;
  /** The name, without the daemon's leading `/`. */
  name: string;
  labels: Readonly<Record<string, string>>;
}

export interface FakeNetwork {
  /** The full 64-character hex id. */
  id: string;
  name: string;
}

/** The daemon's default `bridge` network. */
export const BRIDGE_NETWORK: Readonly<FakeNetwork> = { id: `b7${"0".repeat(62)}`, name: "bridge" };

export interface DockerApiOptions {
  /** Images the daemon has, by the reference a client inspects them under. */
  images: ReadonlyMap<string, FakeImage>;
  /** Containers the daemon has: `GET /containers/json` lists them all. */
  containers: ReadonlyArray<FakeContainer>;
  /** Networks the daemon has; `bridge` is the one `bridgeGateway` belongs to. */
  networks: ReadonlyArray<FakeNetwork>;
  /** `GET /version` → `Arch`. */
  arch: string;
  /** `GET /networks/bridge` → the IPv4 gateway. */
  bridgeGateway: string;
  /** `GET /info` → `name=rootless` among the `SecurityOptions`. */
  rootless: boolean;
}

/** What `resolveRef` finds for a ref: the daemon's id, name, then unique-prefix order. */
type Resolved<T> = { kind: "found"; item: T } | { kind: "missing" } | { kind: "ambiguous" };

/**
 * Answers `GET /version`, `GET /info`, `GET /images/{name}/json` (404 for an
 * unknown image), `GET /containers/json`, `GET /containers/{ref}/json`,
 * `GET /networks/{ref}`, `POST /containers/create` (201) and
 * `POST /containers/{ref}/exec` (201 with a fresh exec id). A container or
 * network ref resolves as the daemon resolves it: full id, then name, then
 * unique id prefix; an ambiguous prefix gets the daemon's 400 and an unknown
 * ref its 404. A path with an empty, `.` or `..` segment gets the 301 the
 * daemon's router answers it with. Everything else gets `200 {}`.
 */
export function dockerApi(opts: DockerApiOptions): FakeDaemonResponder {
  let execs = 0;
  return (req, res) => {
    const path = decodedPath(req.url);
    if (path === null) {
      respondJson(res, 400, { message: "invalid URL escape" });
      return;
    }
    // The daemon's router redirects a path with an empty, `.` or `..` segment to its clean form.
    if (/\/\/|\/\.{1,2}(\/|$)/.test(path)) {
      res.writeHead(301, { location: "/" });
      res.end();
      return;
    }
    const image = /^\/images\/(.+)\/json$/.exec(path);
    if (req.method === "GET" && image?.[1] !== undefined) {
      const found = opts.images.get(image[1]);
      if (found === undefined) {
        respondJson(res, 404, { message: `No such image: ${image[1]}` });
        return;
      }
      respondJson(res, 200, { Id: found.id, Config: { Env: found.env } });
      return;
    }
    if (req.method === "GET" && path === "/version") {
      respondJson(res, 200, {
        Version: "29.0.0",
        ApiVersion: "1.52",
        Os: "linux",
        Arch: opts.arch,
      });
      return;
    }
    if (req.method === "GET" && path === "/info") {
      respondJson(res, 200, {
        SecurityOptions: [
          "name=seccomp,profile=builtin",
          ...(opts.rootless ? ["name=rootless"] : []),
        ],
      });
      return;
    }
    if (req.method === "GET" && path === "/containers/json") {
      respondJson(
        res,
        200,
        opts.containers.map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.labels })),
      );
      return;
    }
    const inspect = /^\/containers\/(.+)\/json$/.exec(path);
    if (req.method === "GET" && inspect?.[1] !== undefined) {
      const ref = inspect[1];
      answerResolved(res, resolveRef(opts.containers, ref), {
        missing: `No such container: ${ref}`,
        ambiguous: ref,
        found: (c) => [200, { Id: c.id, Name: `/${c.name}`, Config: { Labels: c.labels } }],
      });
      return;
    }
    const network = /^\/networks\/(.+)$/.exec(path);
    if (req.method === "GET" && network?.[1] !== undefined) {
      const ref = network[1];
      answerResolved(res, resolveRef(opts.networks, ref), {
        missing: `network ${ref} not found`,
        ambiguous: ref,
        found: (n) => [
          200,
          {
            Id: n.id,
            Name: n.name,
            IPAM: {
              Config:
                n.name === "bridge"
                  ? [{ Subnet: "172.17.0.0/16", Gateway: opts.bridgeGateway }]
                  : [],
            },
          },
        ],
      });
      return;
    }
    if (req.method === "POST" && path === "/containers/create") {
      respondJson(res, 201, { Id: "child-container-1", Warnings: [] });
      return;
    }
    const exec = /^\/containers\/(.+)\/exec$/.exec(path);
    if (req.method === "POST" && exec?.[1] !== undefined) {
      const ref = exec[1];
      answerResolved(res, resolveRef(opts.containers, ref), {
        missing: `No such container: ${ref}`,
        ambiguous: ref,
        found: () => {
          execs += 1;
          return [201, { Id: createHash("sha256").update(`exec-${execs}`).digest("hex") }];
        },
      });
      return;
    }
    respondJson(res, 200, {});
  };
}

/** The path without its query and version prefix, percent-decoded as the daemon decodes it. */
function decodedPath(url: string): string | null {
  try {
    return decodeURIComponent(url.split("?")[0] ?? "").replace(/^\/v[\d.]+/, "");
  } catch {
    return null;
  }
}

function resolveRef<T extends { id: string; name: string }>(
  items: ReadonlyArray<T>,
  ref: string,
): Resolved<T> {
  const exact = items.find((i) => i.id === ref) ?? items.find((i) => i.name === ref);
  if (exact !== undefined) return { kind: "found", item: exact };
  const prefixed = items.filter((i) => i.id.startsWith(ref));
  const [only, ...rest] = prefixed;
  if (only === undefined) return { kind: "missing" };
  return rest.length === 0 ? { kind: "found", item: only } : { kind: "ambiguous" };
}

/** The daemon's answers to a resolved ref: its 404 wording, its 400 for an ambiguous prefix, or a found body. */
interface RefAnswers<T> {
  missing: string;
  ambiguous: string;
  found: (item: T) => [status: number, body: unknown];
}

function answerResolved<T>(
  res: http.ServerResponse,
  resolved: Resolved<T>,
  answers: RefAnswers<T>,
): void {
  match(resolved)
    .with({ kind: "missing" }, () => respondJson(res, 404, { message: answers.missing }))
    .with({ kind: "ambiguous" }, () =>
      respondJson(res, 400, {
        message: `multiple IDs found with provided prefix: ${answers.ambiguous}`,
      }),
    )
    .with({ kind: "found" }, ({ item }) => {
      const [status, body] = answers.found(item);
      respondJson(res, status, body);
    })
    .exhaustive();
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
