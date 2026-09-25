import { describe, expect, it, vi } from "vitest";
import { expectDefined } from "./assertions.js";
import { createWireRecorder } from "./wire-recorder.js";

/** An inner fetch that answers every request with `respond()` and keeps what it was sent. */
function stubFetch(respond: () => Response) {
  const received: Array<{ url: string; headers: Headers; text: string }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    received.push({ url: req.url, headers: req.headers, text: await req.text() });
    return respond();
  });
  return { fetch, received };
}

function sse(events: ReadonlyArray<unknown>): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function post(body: string, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json", ...headers }, body };
}

const ANTHROPIC_USAGE = {
  input_tokens: 12,
  output_tokens: 1,
  cache_read_input_tokens: 7360,
  cache_creation_input_tokens: 68,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 68 },
};

describe("createWireRecorder", () => {
  it("records the URL, redacted headers and parsed body, and forwards the body bytes untouched", async () => {
    const inner = stubFetch(() => json({ id: "msg_1" }));
    const recorder = createWireRecorder(inner.fetch);
    // Spacing and `1.0` survive only if the recorder forwards the original text.
    const raw = '{"model": "claude-sonnet-5", "max_tokens": 1.0}';

    await recorder.fetch(
      "https://api.anthropic.com/v1/messages",
      post(raw, { "x-api-key": "sk-secret", "anthropic-version": "2023-06-01" }),
    );

    const sent = expectDefined(inner.received[0], "inner request");
    expect(sent.text).toBe(raw);
    expect(sent.headers.get("x-api-key")).toBe("sk-secret");

    const exchange = expectDefined(recorder.exchanges[0], "exchange");
    expect(exchange.request).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "[REDACTED]",
      },
      body: { model: "claude-sonnet-5", max_tokens: 1 },
    });
  });

  it("accepts a Request object, the shape the failure-logging wrapper passes on", async () => {
    const inner = stubFetch(() => json({ id: "msg_1" }));
    const recorder = createWireRecorder(inner.fetch);

    await recorder.fetch(
      new Request("https://api.anthropic.com/v1/messages", post('{"model":"m"}')),
    );

    expect(recorder.exchanges[0]?.request.body).toEqual({ model: "m" });
    expect(inner.received[0]?.text).toBe('{"model":"m"}');
  });

  it("sends and records what the mutator returns", async () => {
    const inner = stubFetch(() => json({ id: "msg_2" }));
    const recorder = createWireRecorder(inner.fetch, {
      mutate: (url, init) => {
        expect(url).toBe("https://api.anthropic.com/v1/messages");
        const headers = new Headers(init.headers);
        headers.set("anthropic-beta", "some-beta-2026-01-01");
        return {
          headers,
          body: { ...init.body, diagnostics: { previous_message_id: "msg_1" } },
        };
      },
    });

    await recorder.fetch("https://api.anthropic.com/v1/messages", post('{"model":"m"}'));

    const sent = expectDefined(inner.received[0], "inner request");
    expect(JSON.parse(sent.text)).toEqual({
      model: "m",
      diagnostics: { previous_message_id: "msg_1" },
    });
    expect(sent.headers.get("anthropic-beta")).toBe("some-beta-2026-01-01");
    const recorded = expectDefined(recorder.exchanges[0], "exchange").request;
    expect(recorded.body).toEqual({ model: "m", diagnostics: { previous_message_id: "msg_1" } });
    expect(recorded.headers["anthropic-beta"]).toBe("some-beta-2026-01-01");
  });

  it("captures an Anthropic stream's message_start id, usage and diagnostics, and passes the stream through", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_abc",
          model: "claude-sonnet-5",
          usage: ANTHROPIC_USAGE,
          diagnostics: { cache_miss_reason: null },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    const recorder = createWireRecorder(stubFetch(() => sse(events)).fetch);

    const res = await recorder.fetch("https://api.anthropic.com/v1/messages", post("{}"));
    const passedThrough = await res.text();

    expect(passedThrough).toBe(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
    await expect(expectDefined(recorder.exchanges[0], "exchange").response).resolves.toEqual({
      status: 200,
      id: "msg_abc",
      usage: ANTHROPIC_USAGE,
      diagnostics: { cache_miss_reason: null },
    });
  });

  it("captures an Anthropic JSON body's id, usage and diagnostics", async () => {
    const recorder = createWireRecorder(
      stubFetch(() =>
        json({ id: "msg_json", type: "message", usage: ANTHROPIC_USAGE, diagnostics: null }),
      ).fetch,
    );

    await recorder.fetch("https://api.anthropic.com/v1/messages", post("{}"));

    await expect(expectDefined(recorder.exchanges[0], "exchange").response).resolves.toEqual({
      status: 200,
      id: "msg_json",
      usage: ANTHROPIC_USAGE,
      diagnostics: null,
    });
  });

  it("captures the usage an OpenAI stream reports in its final chunk", async () => {
    const usage = {
      prompt_tokens: 4711,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 3840 },
    };
    const res = new Response(
      [
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ delta: { content: "hi" } }], usage: null })}`,
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [], usage })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const recorder = createWireRecorder(stubFetch(() => res).fetch);

    const out = await recorder.fetch("https://openrouter.ai/api/v1/chat/completions", post("{}"));
    await out.text();

    await expect(expectDefined(recorder.exchanges[0], "exchange").response).resolves.toEqual({
      status: 200,
      id: "chatcmpl-1",
      usage,
      diagnostics: undefined,
    });
  });

  it("captures the usage of an OpenAI JSON body", async () => {
    const usage = { prompt_tokens: 50, completion_tokens: 2 };
    const recorder = createWireRecorder(
      stubFetch(() => json({ id: "chatcmpl-2", object: "chat.completion", usage })).fetch,
    );

    await recorder.fetch("https://api.openai.com/v1/chat/completions", post("{}"));

    await expect(expectDefined(recorder.exchanges[0], "exchange").response).resolves.toEqual({
      status: 200,
      id: "chatcmpl-2",
      usage,
      diagnostics: undefined,
    });
  });

  it("records an error response's status without a usage", async () => {
    const recorder = createWireRecorder(
      stubFetch(() => json({ type: "error", error: { type: "overloaded_error" } }, 529)).fetch,
    );

    const res = await recorder.fetch("https://api.anthropic.com/v1/messages", post("{}"));

    expect(res.status).toBe(529);
    await expect(expectDefined(recorder.exchanges[0], "exchange").response).resolves.toEqual({
      status: 529,
      id: undefined,
      usage: undefined,
      diagnostics: undefined,
    });
  });

  it("rethrows a network failure and rejects the exchange's response with it", async () => {
    const boom = new TypeError("fetch failed");
    const recorder = createWireRecorder(
      vi.fn(async () => {
        throw boom;
      }),
    );

    await expect(recorder.fetch("https://api.anthropic.com/v1/messages", post("{}"))).rejects.toBe(
      boom,
    );
    await expect(expectDefined(recorder.exchanges[0], "exchange").response).rejects.toBe(boom);
  });

  it("refuses a request body that is not a JSON object", async () => {
    const inner = stubFetch(() => json({}));
    const recorder = createWireRecorder(inner.fetch);

    await expect(
      recorder.fetch("https://api.anthropic.com/v1/messages", post("not json")),
    ).rejects.toThrow(/JSON object/);
    expect(inner.fetch).not.toHaveBeenCalled();
  });

  it("returns a copy of the exchange list", async () => {
    const recorder = createWireRecorder(stubFetch(() => json({})).fetch);
    const before = recorder.exchanges;

    await recorder.fetch("https://api.anthropic.com/v1/messages", post("{}"));

    expect(before).toHaveLength(0);
    expect(recorder.exchanges).toHaveLength(1);
  });
});
