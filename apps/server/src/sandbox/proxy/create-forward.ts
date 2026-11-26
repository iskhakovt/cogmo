/**
 * Sending a checked container create to the daemon, and recording the child
 * it makes before answering (design/sandbox.md → Proxy Design → Child
 * containers). The daemon's answer is read whole: on a 201 the proxy reads
 * the child's `Id` and inserts its row, and only then answers the client, so
 * every later request on the child finds the row it is owned by.
 *
 * The create is bound to neither the client's connection nor the task's
 * sockets. A client that hangs up still gets its container a row; the
 * daemon request is aborted only by `upstream.signal`, which teardown fires
 * once it has waited for creates in flight.
 */

import * as http from "node:http";
import type { Result } from "neverthrow";
import { match } from "ts-pattern";
import { logger } from "../../logger.js";
import { describeError } from "../../util/describe-error.js";
import type { Upstream } from "./forward.js";
import {
  isAbortError,
  jsonRequestHeaders,
  pathOf,
  readBody,
  rebuiltResponseHeaders,
  respondJson,
  respondRejection,
} from "./http-io.js";
import type { CreateAdmission } from "./in-flight-creates.js";
import { daemonFailed, type ProxyRejection } from "./rejection.js";
import { createdId } from "./response-filters.js";

const log = logger.child({ component: "sandbox.proxy" });

/** Bound on the daemon's answer to a create: `{"Id": …, "Warnings": […]}`, or an error. */
const MAX_CREATE_REPLY_BYTES = 1024 * 1024;

/** A checked container create. */
export interface CreateForward {
  /** The canonical path with the query keys the daemon reads. */
  path: string;
  /** The body the create policy rebuilt. */
  body: Buffer;
  /**
   * Insert the row of the child a 201 names. `record_failed` once the
   * container has been removed, or left to the orphan pass.
   */
  record(dockerId: string): Promise<Result<void, ProxyRejection>>;
  /** The create's admission, held from its checks to its answer. */
  admission: CreateAdmission;
}

/**
 * What the client gets: the daemon's answer as it came, a rejection in its
 * place, or a 500 for a bug in recording the child.
 */
type CreateAnswer =
  | { kind: "relay"; status: number; headers: http.OutgoingHttpHeaders; body: Buffer }
  | { kind: "reject"; rejection: ProxyRejection }
  | { kind: "internal_error"; message: string };

/** Send the create; resolves once the child's row is recorded, or the create has failed, and the client answered. */
export function forwardCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: Upstream,
  plan: CreateForward,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let answered = false;
  const answer = (outcome: CreateAnswer) => {
    if (answered) return;
    answered = true;
    // A client that hung up, or a connection teardown destroyed, gets nothing.
    if (!res.headersSent && !res.destroyed) send(res, outcome);
    resolve();
  };
  // Once the daemon has answered, the read of its reply decides the outcome.
  let replied = false;
  const outgoing = http.request(
    {
      socketPath: upstream.socketPath,
      method: "POST",
      path: plan.path,
      headers: jsonRequestHeaders(req, plan.body),
      signal: upstream.signal,
    },
    (reply) => {
      replied = true;
      readCreateReply(req, reply, plan).then(answer, (cause: unknown) => {
        log.error({ err: cause, path: pathOf(req) }, "recording a created child failed");
        answer({ kind: "internal_error", message: `Cogmo proxy: ${describeError(cause)}` });
      });
    },
  );
  outgoing.on("error", (cause) => {
    if (replied) return;
    if (!isAbortError(cause)) log.warn({ err: cause.message, path: pathOf(req) }, "upstream error");
    answer({
      kind: "reject",
      rejection: daemonFailed(`Cogmo proxy upstream error: ${cause.message}`),
    });
  });
  outgoing.end(plan.body);
  return promise;
}

/**
 * The daemon's answer, once a 201's child has its row. A 201 that cannot be
 * read, or names no container, is `daemon_failed`: the daemon may hold a
 * container nothing can name, which the orphan pass removes once its grace
 * window has passed.
 */
async function readCreateReply(
  req: http.IncomingMessage,
  reply: http.IncomingMessage,
  plan: CreateForward,
): Promise<CreateAnswer> {
  const read = await readBody(reply, MAX_CREATE_REPLY_BYTES);
  if (read.isErr()) {
    log.warn({ path: pathOf(req), failure: read.error.kind }, "the daemon's create reply was lost");
    return {
      kind: "reject",
      rejection: daemonFailed("Cogmo proxy: the daemon's answer to the create could not be read"),
    };
  }
  const status = reply.statusCode ?? 502;
  const relayed: CreateAnswer = {
    kind: "relay",
    status,
    headers: rebuiltResponseHeaders(reply.headers, read.value.length),
    body: read.value,
  };
  if (status !== 201) return relayed;
  const dockerId = createdId(read.value);
  if (dockerId === null) {
    log.warn({ path: pathOf(req) }, "the daemon's create reply names no container");
    return {
      kind: "reject",
      rejection: daemonFailed("Cogmo proxy: the daemon's answer to the create names no container"),
    };
  }
  const recorded = await plan.record(dockerId);
  return recorded.match(
    (): CreateAnswer => relayed,
    (rejection): CreateAnswer => ({ kind: "reject", rejection }),
  );
}

function send(res: http.ServerResponse, outcome: CreateAnswer): void {
  match(outcome)
    .with({ kind: "relay" }, ({ status, headers, body }) => {
      res.writeHead(status, headers);
      res.end(body);
    })
    .with({ kind: "reject" }, ({ rejection }) => respondRejection(res, rejection))
    .with({ kind: "internal_error" }, ({ message }) => respondJson(res, 500, { message }))
    .exhaustive();
}
