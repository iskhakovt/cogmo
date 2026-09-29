import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { logger } from "../logger.js";
import type {
  SseConnection,
  SseFrame,
  WebStreamRegistry,
} from "../transport/adapters/web/stream-registry.js";
import type { Transport, TransportError } from "../transport/transport.js";
import { readJsonBody, sendBodyError } from "./body.js";

/**
 * Chat HTTP surface for the web channel — the inbound + streaming half of the UI
 * server, distinct from the oRPC admin API. All three routes are auth-gated by
 * the caller (`server.ts`); the owner handle comes from the gate, never the body.
 *
 *   POST /api/chat                    create a conversation -> { conversationId }
 *   GET  /api/chat/:cid/stream?tab=T  bind tab T to the conversation + open SSE
 *   POST /api/chat/:cid?tab=T         emit a user turn (response streams over SSE)
 *
 * A tab is a per-tab opaque id the SPA mints; it's the session's `platformAddress`
 * and the SSE registry key. The stream open is the single session owner — it
 * resumes the tab's session onto the conversation (`receive:"all"`); the send
 * route resolves that session and emits. Phase 2a streams live only; there's no
 * `Last-Event-ID` replay yet (a mid-stream disconnect recovers the completed turn
 * from history on reload).
 */

const HEARTBEAT_MS = 15_000;
const TAB_MAX_CHARS = 200;

// Only non-emptiness is enforced here; the 64 KB request-body cap (413) is the
// real length bound, and it trips before any larger field limit could.
const SendBody = z.object({ text: z.string().trim().min(1) });

const STREAM_PATH = /^\/api\/chat\/([^/]+)\/stream$/;
const CONVO_PATH = /^\/api\/chat\/([^/]+)$/;

export interface ChatRouteDeps {
  transport: Transport;
  registry: WebStreamRegistry;
  /** Owner handle resolved by the gate — passed to identity-checked Transport calls. */
  ownerHandle: string;
  /** Server-lifetime signal; aborting it ends every open stream. */
  shutdownSignal: AbortSignal;
  sessionCloses: SessionCloses;
}

/**
 * Session closes in flight. Each is best-effort — a failure is logged, since
 * the tab is gone — but shutdown waits for them so the process doesn't exit
 * mid-write.
 */
export class SessionCloses {
  #pending = new Set<Promise<void>>();

  start(transport: Transport, sessionId: string): void {
    const closing: Promise<void> = transport
      .closeSession(sessionId)
      .catch((err: unknown) =>
        logger.debug({ err, sessionId }, "web chat: closeSession on disconnect failed"),
      )
      .finally(() => this.#pending.delete(closing));
    this.#pending.add(closing);
  }

  /** Resolves once every close started so far has settled. */
  async settled(): Promise<void> {
    await Promise.all(this.#pending);
  }
}

/** SSE response headers — disable caching + proxy buffering so frames flush immediately. */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Tell an nginx/ingress hop not to buffer the stream.
  "X-Accel-Buffering": "no",
} as const;

export function serializeFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  // Per the SSE spec each `\n` in the payload becomes its own `data:` line.
  for (const dataLine of frame.data.split("\n")) lines.push(`data: ${dataLine}`);
  return `${lines.join("\n")}\n\n`;
}

function sseConnection(res: ServerResponse): SseConnection {
  return {
    send(frame) {
      // `destroyed` is the precise "socket gone" signal — `writableEnded` only
      // flips on our own `end()`, at shutdown.
      // Reported back to the caller: this connection stays registered until
      // the response's `close` handler runs a tick later, so a dropped frame
      // here is invisible to the registry's "is anyone registered" check.
      if (res.destroyed || res.writableEnded) return false;
      res.write(serializeFrame(frame));
      return true;
    },
  };
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(message);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Map a TransportError to an HTTP status. Ownership/identity -> 4xx; the rest are unexpected. */
function transportErrorStatus(error: TransportError): number {
  switch (error.code) {
    case "conversation_not_found":
      return 404;
    case "access_denied":
    case "identity_rejected":
      return 403;
    case "session_not_found":
      // The send route's session can be closed between resolve and emit (e.g. a
      // racing disconnect cleanup) — a benign 409, same as the no-session case.
      return 409;
    default:
      return 500;
  }
}

function validTab(tab: string | null): tab is string {
  return tab !== null && tab.length > 0 && tab.length <= TAB_MAX_CHARS;
}

/** Dispatch a `/api/chat...` request. Returns once handled (the SSE case leaves the socket open). */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: ChatRouteDeps,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const query = new URL(req.url ?? "/", "http://localhost").searchParams;
  const tab = query.get("tab");

  if (method === "POST" && path === "/api/chat") {
    await handleCreate(req, res, deps);
    return;
  }

  const streamMatch = STREAM_PATH.exec(path);
  if (method === "GET" && streamMatch?.[1]) {
    await handleStream(req, res, tab, streamMatch[1], deps);
    return;
  }

  const convoMatch = CONVO_PATH.exec(path);
  if (method === "POST" && convoMatch?.[1]) {
    await handleSend(req, res, tab, convoMatch[1], deps);
    return;
  }

  sendText(res, 404, "Not Found");
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ChatRouteDeps,
): Promise<void> {
  const tab = new URL(req.url ?? "/", "http://localhost").searchParams.get("tab");
  if (!validTab(tab)) {
    sendText(res, 400, "missing or invalid tab");
    return;
  }
  // Drain any body (none expected today) so a keep-alive socket doesn't desync.
  try {
    await readJsonBody(req);
  } catch (err) {
    sendBodyError(res, err);
    return;
  }
  const result = await deps.transport.createConversation(tab, deps.ownerHandle, {
    isPrivate: true,
  });
  if (result.isErr()) {
    sendText(res, transportErrorStatus(result.error), result.error.code);
    return;
  }
  // `createConversation` opens a session as a side effect, but the stream open
  // (`resumeConversation`) is the real session owner. Close the one we just
  // opened so a create-without-streaming doesn't orphan a `receive:"all"`
  // session until the idle timer reclaims it; the stream open mints a fresh one.
  deps.sessionCloses.start(deps.transport, result.value.id);
  sendJson(res, 200, { conversationId: result.value.conversationId });
}

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  tab: string | null,
  conversationId: string,
  deps: ChatRouteDeps,
): Promise<void> {
  if (!validTab(tab)) {
    sendText(res, 400, "missing or invalid tab");
    return;
  }
  // Bind this tab to the conversation: resume swaps the tab's session onto it
  // with `receive:"all"`, verifying ownership + privacy before we open the SSE.
  const resumed = await deps.transport.resumeConversation(tab, deps.ownerHandle, {
    conversationId,
  });
  if (resumed.isErr()) {
    sendText(res, transportErrorStatus(resumed.error), resumed.error.code);
    return;
  }
  const sessionId = resumed.value.id;

  // The client may have disconnected while `resumeConversation` was awaited. The
  // connection's `close` fires once, before we attach a listener below — so a
  // listener registered now would never run, leaking the heartbeat + the open
  // session. Bail with cleanup instead of opening a stream nothing is attached to.
  if (req.destroyed) {
    deps.sessionCloses.start(deps.transport, sessionId);
    return;
  }
  // Shutdown began during the resume: its abort has already fired, so a
  // stream opened now would never be ended.
  if (deps.shutdownSignal.aborted) {
    deps.sessionCloses.start(deps.transport, sessionId);
    sendText(res, 503, "shutting down");
    return;
  }

  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();
  const deregister = deps.registry.register(tab, sseConnection(res));
  res.write(serializeFrame({ event: "ready", data: JSON.stringify({ conversationId }) }));

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  // Runs once, whichever ends the stream first: the connection dropping or
  // shutdown. Closing the session keeps abandoned tabs from accumulating
  // `receive:"all"` sessions; a reconnect resumes a fresh one.
  let open = true;
  const teardown = () => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    deregister();
    deps.shutdownSignal.removeEventListener("abort", onShutdown);
    deps.sessionCloses.start(deps.transport, sessionId);
  };
  // A clean end, not a reset: eventsource-client reconnects after either,
  // but a reset surfaces as a network error.
  const onShutdown = () => {
    teardown();
    res.end();
  };
  deps.shutdownSignal.addEventListener("abort", onShutdown, { once: true });
  // Anchor disconnect cleanup on the long-lived RESPONSE stream: `res` `close`
  // fires when the connection drops or after `onShutdown` ends it. (`req`
  // `close` is ambiguous for a bodyless GET — it can also signal that the
  // request was fully received.)
  res.on("close", teardown);
}

async function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  tab: string | null,
  conversationId: string,
  deps: ChatRouteDeps,
): Promise<void> {
  if (!validTab(tab)) {
    sendText(res, 400, "missing or invalid tab");
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendBodyError(res, err);
    return;
  }
  const parsed = SendBody.safeParse(body);
  if (!parsed.success) {
    sendText(res, 400, "Bad Request");
    return;
  }

  const session = await deps.transport.resolveSession(tab);
  if (!session) {
    sendText(res, 409, "no open session — connect the stream first");
    return;
  }
  if (session.conversationId !== conversationId) {
    sendText(res, 409, "session/conversation mismatch");
    return;
  }

  const result = await deps.transport.emit(session.id, parsed.data.text, new Date());
  if (result.isErr()) {
    sendText(res, transportErrorStatus(result.error), result.error.code);
    return;
  }
  sendJson(res, 202, { ok: true });
}
