/**
 * What a Bot API exchange says about the receive loop: each `getUpdates`
 * outcome, and the error a supervisor transition records
 * (design/liveness.md → Telegram receive loop → Signals). A `ChannelError`'s
 * `code` is normalized and never carries an error's message, since a
 * node-fetch error's names the request URL.
 */

import { GrammyError, HttpError } from "grammy";
import { match, P } from "ts-pattern";
import type { ChannelError, RetryCause } from "../../types.js";

/** What one `getUpdates` outcome does to the run's receive sub-state. */
export type ReceiveOutcome =
  /** An array of updates, each with an id; empty on a long-poll timeout. */
  | { kind: "batch" }
  /** A 401 or 409, which ends the run for the supervisor to handle. */
  | { kind: "supervised" }
  /** An outcome grammY retries within the run. */
  | { kind: "retrying"; cause: Exclude<RetryCause, "conflict">; error: ChannelError };

type Retrying = Extract<ReceiveOutcome, { kind: "retrying" }>;

interface RequestFailure {
  readonly cause: Extract<RetryCause, "network" | "bad_reply" | "unknown">;
  readonly code: string;
}

const UNKNOWN_FAILURE: RequestFailure = { cause: "unknown", code: "unknown" };

/** The errors node-fetch, grammY's HTTP client, rejects with. */
const NODE_FETCH_ERROR = P.union("FetchError", "AbortError");
/** A system error's code, such as `ECONNRESET`. */
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]*$/;
/** A node-fetch error's `type`, such as `system` or `aborted`. */
const FETCH_TYPE = /^[a-z][a-z-]*$/;
/** grammY's client timeout: `Request to '<method>' timed out after <n> seconds`. */
const CLIENT_TIMEOUT = /^Request to '[^']*' timed out after /;

/** An update id grammY can take the next offset from. */
export function isUpdateId(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** The outcome of a `getUpdates` reply, which grammY hands its transformers before checking `ok`. */
export function replyOutcome(reply: unknown): ReceiveOutcome {
  return match(reply)
    .returnType<ReceiveOutcome>()
    .with({ ok: true, result: P.array({ update_id: P.when(isUpdateId) }) }, () => ({
      kind: "batch",
    }))
    .with({ ok: false, error_code: P.union(401, 409) }, () => ({ kind: "supervised" }))
    .with({ ok: false, error_code: P.number.int().between(400, 599) }, ({ error_code }) => ({
      kind: "retrying",
      cause: refusalCause(error_code),
      error: { code: String(error_code), detail: description(reply) },
    }))
    .otherwise(() => ({
      kind: "retrying",
      cause: "bad_reply",
      error: { code: "unexpected-reply", detail: description(reply) },
    }));
}

/** The outcome of a `getUpdates` that threw: grammY retries every one within the run. */
export function failureOutcome(err: unknown): Retrying {
  const { cause, code } = requestFailure(err);
  return { kind: "retrying", cause, error: { code, detail: null } };
}

/** The error a supervisor transition records: a Bot API refusal by its code, anything else as `getUpdates` reads a throw. */
export function channelError(err: unknown): ChannelError {
  return match(err)
    .returnType<ChannelError>()
    .with(P.instanceOf(GrammyError), (refusal) => ({
      code: match(refusal.error_code)
        .with(P.number.int().gte(0), String)
        .otherwise(() => "unknown"),
      detail: description(refusal),
    }))
    .otherwise(() => ({ code: requestFailure(err).code, detail: null }));
}

/** A 4xx or 5xx other than 401 and 409. */
function refusalCause(errorCode: number): Retrying["cause"] {
  return match(errorCode)
    .returnType<Retrying["cause"]>()
    .with(429, () => "rate_limited")
    .with(P.number.gte(500), () => "server_error")
    .otherwise(() => "client_error");
}

/** An `HttpError` read by the error it wraps; any other throw, such as one building the request, is `unknown`. */
function requestFailure(err: unknown): RequestFailure {
  if (!(err instanceof HttpError)) return UNKNOWN_FAILURE;
  return match(err.error)
    .returnType<RequestFailure>()
    .with({ name: NODE_FETCH_ERROR, type: "invalid-json" }, () => ({
      cause: "bad_reply",
      code: "invalid-json",
    }))
    .with({ name: NODE_FETCH_ERROR, code: P.string.regex(SYSTEM_CODE) }, ({ code }) => ({
      cause: "network",
      code,
    }))
    .with({ name: NODE_FETCH_ERROR, type: P.string.regex(FETCH_TYPE) }, ({ type }) => ({
      cause: "network",
      code: type,
    }))
    .with({ name: NODE_FETCH_ERROR }, () => ({ cause: "network", code: "unknown" }))
    .with(P.intersection(P.instanceOf(Error), { message: P.string.regex(CLIENT_TIMEOUT) }), () => ({
      cause: "network",
      code: "timeout",
    }))
    .otherwise(() => UNKNOWN_FAILURE);
}

/** Telegram's `description`, or null. */
function description(source: unknown): string | null {
  return match(source)
    .with({ description: P.string }, (s) => s.description)
    .otherwise(() => null);
}
