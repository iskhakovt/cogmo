import { create } from "@bufbuild/protobuf";
import { type ConnectResponse, ConnectResponseSchema } from "@cogmo/connector-proto";
import { describe, expect, it, vi } from "vitest";
import type { HubSession } from "./session.js";
import { Session } from "./session.js";
import type { ActiveConnector } from "./store/index.js";

const CONNECTOR: ActiveConnector = { id: "conn-1", name: "paseo", kind: "coding", tokenHash: "h" };

function heartbeat(): ConnectResponse {
  return create(ConnectResponseSchema, { message: { case: "heartbeat", value: {} } });
}

function cancel(jobId: string): ConnectResponse {
  return create(ConnectResponseSchema, { message: { case: "cancel", value: { jobId } } });
}

/** The next message, or `"pending"` if the iterator has none ready. */
async function nextOrPending(
  iterator: AsyncIterator<ConnectResponse>,
): Promise<ConnectResponse | "done" | "pending"> {
  const next = iterator.next().then((result) => (result.done ? ("done" as const) : result.value));
  const pending = new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")));
  return Promise.race([next, pending]);
}

describe("messages", () => {
  it("yields queued messages in order while the session is open", async () => {
    const session = new Session(CONNECTOR, () => {});
    session.send(cancel("a"));
    session.send(cancel("b"));
    const iterator = session.messages(new AbortController().signal)[Symbol.asyncIterator]();
    expect(await nextOrPending(iterator)).toEqual(cancel("a"));
    expect(await nextOrPending(iterator)).toEqual(cancel("b"));
    expect(await nextOrPending(iterator)).toBe("pending");
  });

  it("yields nothing queued once the hub ends the session", async () => {
    const session = new Session(CONNECTOR, () => {});
    session.send(cancel("a"));
    session.end("replaced");
    const iterator = session.messages(new AbortController().signal)[Symbol.asyncIterator]();
    expect(await nextOrPending(iterator)).toBe("done");
  });

  it("yields nothing queued once its signal aborts", async () => {
    const session = new Session(CONNECTOR, () => {});
    session.send(cancel("a"));
    const controller = new AbortController();
    controller.abort();
    const iterator = session.messages(controller.signal)[Symbol.asyncIterator]();
    expect(await nextOrPending(iterator)).toBe("done");
  });

  it("stops a waiting iterator when the session ends", async () => {
    const session = new Session(CONNECTOR, () => {});
    const iterator = session.messages(new AbortController().signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    session.end("shutdown");
    expect(await next).toEqual({ done: true, value: undefined });
  });
});

describe("heartbeat", () => {
  it("queues a heartbeat only when nothing else is waiting", async () => {
    const session = new Session(CONNECTOR, () => {});
    session.heartbeat();
    session.heartbeat();
    session.send(cancel("a"));
    session.heartbeat();
    const iterator = session.messages(new AbortController().signal)[Symbol.asyncIterator]();
    expect(await nextOrPending(iterator)).toEqual(heartbeat());
    expect(await nextOrPending(iterator)).toEqual(cancel("a"));
    expect(await nextOrPending(iterator)).toBe("pending");
  });
});

describe("ending", () => {
  it("records why the hub ended it, aborts `ended`, and reports itself closed once", () => {
    const onClosed = vi.fn<(session: HubSession) => void>();
    const session = new Session(CONNECTOR, onClosed);
    session.end("unauthenticated");
    session.end("replaced");
    session.close();
    expect(session.endReason).toBe("unauthenticated");
    expect(session.ended.aborted).toBe(true);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("leaves `ended` unaborted and no reason when the connector leaves", () => {
    const session = new Session(CONNECTOR, () => {});
    session.close();
    session.end("replaced");
    expect(session.endReason).toBeNull();
    expect(session.ended.aborted).toBe(false);
  });

  it("drops messages sent after it is over", async () => {
    const session = new Session(CONNECTOR, () => {});
    session.close();
    session.send(cancel("a"));
    const iterator = session.messages(new AbortController().signal)[Symbol.asyncIterator]();
    expect(await nextOrPending(iterator)).toBe("done");
  });
});
