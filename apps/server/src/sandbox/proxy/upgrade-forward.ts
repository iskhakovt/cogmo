/**
 * Sending a checked upgrade to the daemon (design/sandbox.md → Proxy
 * Design → Upgraded streams). The request goes through `http.request` under
 * the canonical path, with its body and `Connection: Upgrade, close`, and
 * every byte the client sends after the body is held until Node's client
 * has parsed the daemon's answer. A `101` opens a raw pipe both ways. Any
 * other answer is read whole and relayed, and both connections end, so no
 * byte the client sent after the body reaches the daemon, whether or not
 * the daemon honours `close`.
 */

import * as http from "node:http";
import type * as net from "node:net";
import { addAbortSignal, type Duplex } from "node:stream";
import * as R from "remeda";
import { logger } from "../../logger.js";
import { readReply, type Upstream } from "./forward.js";
import {
  headerLines,
  isAbortError,
  pathOf,
  rawResponseHead,
  rebuiltResponseHeaders,
  upgradeRequestHeaders,
  writeRawAndDestroy,
  writeRawRejectionAndDestroy,
} from "./http-io.js";
import { daemonFailed } from "./rejection.js";

const log = logger.child({ component: "sandbox.proxy" });

/** A checked upgrade: what reaches the daemon, and the client bytes held after it. */
export interface UpgradeForward {
  /** The canonical path with the re-serialised query. */
  path: string;
  /** The request's body, read whole. */
  body: Buffer;
  /** What the client sent after the body with the request; held until a `101`. */
  head: Buffer;
}

export function forwardUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  upgrade: UpgradeForward,
  upstream: Upstream,
): void {
  // The checks are async: a connection the task's teardown destroyed
  // meanwhile gets no daemon connection. One the client has only ended is
  // forwarded, since a half-open client can still read the answer.
  if (clientSocket.destroyed) return;
  const outgoing = http.request({
    socketPath: upstream.socketPath,
    // A connection of its own, which the answer either hands over or ends.
    agent: false,
    method: req.method,
    path: upgrade.path,
    headers: upgradeRequestHeaders(req, upgrade.body),
    signal: upstream.signal,
  });
  // Once Node has parsed the daemon's answer, its relay owns the client.
  let answered = false;
  outgoing.on("upgrade", (reply, daemon, daemonHead) => {
    answered = true;
    openStream(
      req,
      clientSocket,
      { reply, daemon, daemonHead, clientHead: upgrade.head },
      upstream,
    );
  });
  outgoing.on("response", (reply) => {
    answered = true;
    relayRefusal(clientSocket, outgoing, reply);
  });
  // Until then nothing has reached the client, which gets a 502 for a
  // failed dial, a reset, a clean close or an answer that is not HTTP.
  outgoing.on("error", (cause) => {
    warnUpstream(req, cause);
    if (answered) return;
    writeRawRejectionAndDestroy(
      clientSocket,
      daemonFailed(`Cogmo proxy upstream error: ${cause.message}`),
    );
  });
  // A client that is gone before the daemon has answered closes the request with it.
  clientSocket.once("close", () => outgoing.destroy());
  outgoing.end(upgrade.body);
}

interface Switched {
  /** The daemon's `101`, relayed as it came. */
  reply: http.IncomingMessage;
  daemon: net.Socket;
  /** What the daemon sent after its `101` in the same read. */
  daemonHead: Buffer;
  clientHead: Buffer;
}

/** The daemon switched: relay its `101`, release the held bytes, and pipe both ways. */
function openStream(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  { reply, daemon, daemonHead, clientHead }: Switched,
  upstream: Upstream,
): void {
  // Node's client hands its connection over at the switch, unbound from the
  // request's signal, so it is bound to the task's again.
  addAbortSignal(upstream.signal, daemon);
  daemon.on("error", (cause) => {
    warnUpstream(req, cause);
    clientSocket.destroy(cause);
  });
  clientSocket.once("close", () => daemon.destroy());
  // The daemon connection's end ends the client's and releases it once the
  // rest of the output is flushed, whether or not the client has ended its
  // side.
  daemon.once("end", () => {
    // Nothing the client sends from here has anywhere to go.
    clientSocket.unpipe(daemon);
    clientSocket.end(() => clientSocket.destroy());
  });
  clientSocket.write(
    rawResponseHead(
      reply.statusCode ?? 101,
      reply.statusMessage ?? "",
      R.chunk(reply.rawHeaders, 2).map(([name, value]) => `${name}: ${value ?? ""}`),
    ),
  );
  if (daemonHead.length > 0) clientSocket.write(daemonHead);
  if (clientHead.length > 0) daemon.write(clientHead);
  // `pipe` carries the client's end to the daemon, and the client's
  // connection stays open after it: a client that ends its side after
  // sending stdin still reads the daemon's output.
  clientSocket.pipe(daemon);
  daemon.pipe(clientSocket, { end: false });
}

/**
 * The daemon answered without switching: its answer, read whole, goes to
 * the client framed by its length with `Connection: close`, and both
 * connections end. A daemon that kept its connection open would otherwise
 * parse the client's next bytes as a request nobody checked.
 */
function relayRefusal(
  clientSocket: Duplex,
  outgoing: http.ClientRequest,
  reply: http.IncomingMessage,
): void {
  readReply(reply)
    .match(
      (body) => writeRawAndDestroy(clientSocket, refusalAnswer(reply, body)),
      (rejection) => writeRawRejectionAndDestroy(clientSocket, rejection),
    )
    // The daemon connection ends once its answer is read, whether or not it would close of itself.
    .then(() => outgoing.destroy())
    .catch((cause: unknown) => {
      log.error({ err: cause }, "relaying an upgrade's refusal failed");
      outgoing.destroy();
      clientSocket.destroy();
    });
}

/** The daemon's answer without its hop-by-hop headers, framed by its length. */
function refusalAnswer(reply: http.IncomingMessage, body: Buffer): Buffer {
  const headers = { ...rebuiltResponseHeaders(reply.headers, body.length), connection: "close" };
  return Buffer.concat([
    rawResponseHead(reply.statusCode ?? 502, reply.statusMessage ?? "", headerLines(headers)),
    body,
  ]);
}

function warnUpstream(req: http.IncomingMessage, cause: Error): void {
  if (!isAbortError(cause)) {
    log.warn({ err: cause.message, path: pathOf(req) }, "upstream stream error");
  }
}
