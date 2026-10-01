import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../logger.js";
import { expectDefined, resolvesWithin } from "../../../test/assertions.js";
import { mockAttachmentStore, mockInngest, mockTransport } from "../../../test/factories.js";
import {
  botLifecycle,
  mockBotApi,
  resetGrammyMock,
  runUpdate,
} from "../../../test/telegram/grammy-mock.js";
import { createAdapter } from "../../../test/telegram/harness.js";
import type { StreamingAdapter } from "../../types.js";
import { setup } from "./index.js";

vi.mock("grammy", async () => (await import("../../../test/telegram/grammy-mock.js")).grammyModule);

describe("TelegramAdapter", () => {
  beforeEach(() => {
    resetGrammyMock();
  });

  describe("stop", () => {
    it("waits for the update offset to be confirmed", async () => {
      const confirmed = Promise.withResolvers<void>();
      botLifecycle.stop = () => confirmed.promise;
      const { adapter } = await createAdapter();
      let stopped = false;

      const stopping = adapter.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(stopped).toBe(false);
      confirmed.resolve();
      await stopping;
      expect(stopped).toBe(true);
    });

    it("logs a failed confirmation instead of throwing", async () => {
      const failure = new Error("network down");
      botLifecycle.stop = () => Promise.reject(failure);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { adapter } = await createAdapter();

        await expect(adapter.stop()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith({ err: failure }, expect.any(String));
      } finally {
        warn.mockRestore();
      }
    });

    it("stops polling, then drains the loop", { timeout: 5_000 }, async () => {
      // As in grammY, the polling loop ends only once `stop()` has aborted it.
      const loopEnded = Promise.withResolvers<void>();
      let drained = false;
      botLifecycle.polling = () =>
        loopEnded.promise.then(() => {
          drained = true;
        });
      botLifecycle.stop = async () => {
        setImmediate(() => loopEnded.resolve());
      };
      const { adapter } = await createAdapter();

      await resolvesWithin(adapter.stop(), 2_500, "stop");

      expect(drained).toBe(true);
    });

    it("confirms past the rest of a batch the loop handles after stop()", async () => {
      // grammY's handleUpdates finishes the batch after `stop()`, whose own
      // confirmation stops at the update being handled.
      const handling = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      botLifecycle.polling = async () => {
        for (const updateId of [7, 8, 9]) {
          await runUpdate(updateId, async () => {
            if (updateId !== 7) return;
            handling.resolve();
            await release.promise;
          });
        }
      };
      const { adapter } = await createAdapter();
      await handling.promise;

      const stopping = adapter.stop();
      release.resolve();
      await stopping;

      expect(mockBotApi.getUpdates).toHaveBeenLastCalledWith({ offset: 10, limit: 1, timeout: 0 });
    });

    it("logs a failed confirmation of the handled updates instead of throwing", async () => {
      botLifecycle.polling = () => runUpdate(7, async () => {});
      const failure = new Error("network down");
      mockBotApi.getUpdates.mockRejectedValueOnce(failure);
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { adapter } = await createAdapter();

        await expect(adapter.stop()).resolves.toBeUndefined();
        expect(mockBotApi.getUpdates).toHaveBeenCalledWith({ offset: 8, limit: 1, timeout: 0 });
        expect(warn).toHaveBeenCalledWith({ err: failure }, expect.any(String));
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("deliver sends via bot API", async () => {
    const { adapter } = await createAdapter();
    await adapter.deliver("12345", "response");

    expect(mockBotApi.sendMessage).toHaveBeenCalledWith(12345, "response");
  });

  describe("streaming", () => {
    async function createStreamingAdapter() {
      const { adapter } = await createAdapter();
      return adapter as unknown as StreamingAdapter;
    }

    it("openStream sends initial message on first push", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Hello" });

      expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "Hello");
    });

    it("reuses the open handle when the same runId opens the stream again", async () => {
      // Inngest re-invokes handle-message at every step boundary, and each
      // re-invocation calls `deliveryRouter.prepare()` → `openStream()`
      // again with the same runId. The #activeStreams map must hand back
      // the SAME handle so replay pushes land in the one live Telegram
      // message instead of opening a second bubble.
      const adapter = await createStreamingAdapter();
      const first = await adapter.openStream("42", "run-1");
      await first.push({ type: "text_delta", text: "Hello" });

      const second = await adapter.openStream("42", "run-1");
      expect(second).toBe(first);

      // Pushes through the re-opened reference keep editing the original
      // message — exactly one sendMessage across both references.
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await second.push({ type: "text_delta", text: " again" });
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "Hello again");
    });

    it("opens a fresh handle for the same runId only after finish", async () => {
      // finish() removes the runId from #activeStreams — a later open for
      // the same id (a replay invocation after the stream closed) starts a
      // new handle. Its buffer is empty, so unless something actually
      // pushes, no new Telegram message is created.
      const adapter = await createStreamingAdapter();
      const first = await adapter.openStream("42", "run-1");
      await first.push({ type: "text_delta", text: "done" });
      await first.finish();

      const second = await adapter.openStream("42", "run-1");
      expect(second).not.toBe(first);
      mockBotApi.sendMessage.mockClear();
      await second.finish();
      expect(mockBotApi.sendMessage).not.toHaveBeenCalled();
    });

    it("subsequent pushes edit the message", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Hello" });
      // Advance time past throttle interval
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await handle.push({ type: "text_delta", text: " world" });

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "Hello world");
    });

    it("finish sends final edit", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "done" });
      mockBotApi.editMessageText.mockClear();
      await handle.finish();

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "done", {
        parse_mode: "HTML",
      });
    });

    it("finish falls back to plain text when HTML parse fails", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "done" });
      mockBotApi.editMessageText
        .mockReset()
        .mockRejectedValueOnce(new Error("can't parse entities"))
        .mockResolvedValue(true);

      await handle.finish();

      // First call is the HTML attempt; the retry writes the plain body rather
      // than trusting whatever the throttled edits left on the message.
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(2);
      expect(mockBotApi.editMessageText).toHaveBeenLastCalledWith(42, 100, "done");
    });

    it("finish swallows not-modified on the plain-text retry", async () => {
      // The common case: the throttled edits already wrote this exact plain
      // body, so Telegram rejects the retry as redundant. That's the no-op the
      // retry wants — it must not surface as a failed turn.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "done" });
      mockBotApi.editMessageText
        .mockReset()
        .mockRejectedValueOnce(new Error("can't parse entities"))
        .mockRejectedValueOnce(new Error("message is not modified"))
        .mockResolvedValue(true);

      await expect(handle.finish()).resolves.toEqual(ok(undefined));
    });

    it("abort appends error to message", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "partial" });
      mockBotApi.editMessageText.mockClear();
      await handle.abort("LLM failed");

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, "partial\n\n⚠️ LLM failed");
    });

    it("retract drops the streamed fragment so the next text owns the message alone", async () => {
      // The degraded off-ramp's shape: text streamed and was edited into the
      // live message, then the turn was cut off and the orchestrator retracts
      // before pushing its reply. Without the retraction the reply is appended
      // to the fragment and the user reads a mid-word splice of the two.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "The three key points are: (1) the dep" });
      expect(mockBotApi.sendMessage).toHaveBeenCalledWith(
        42,
        "The three key points are: (1) the dep",
      );
      mockBotApi.editMessageText.mockClear();

      await handle.push({
        type: "retract",
        text: "The three key points are: (1) the dep",
        toolUseIds: [],
      });
      await handle.push({ type: "text_delta", text: "This conversation is too long." });
      await handle.finish();

      // Every write after the retraction carries the reply and nothing else,
      // and it edits the message the fragment was in rather than trailing it.
      const bodies = mockBotApi.editMessageText.mock.calls.map((call) => String(call[2]));
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).toContain("This conversation is too long.");
        expect(body).not.toContain("three key points");
      }
      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(42, 100, expect.anything(), {
        parse_mode: "HTML",
      });
      // No second message: the fragment was replaced, not followed.
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("retract keeps the earlier iteration's text and cuts only the named tail", async () => {
      // A multi-iteration turn: the first iteration narrated and ran a tool, so
      // it is in the turn's persisted messages; the second streamed a fragment
      // and then degraded. The retraction names that fragment alone, and the
      // banner appended after it belongs to the same dropped iteration — so
      // both go, and the narration the transcript holds stays on the message.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Let me check the weather.\n" });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await handle.push({ type: "tool_start", id: "t1", name: "get_weather", input: {} });
      await handle.push({ type: "text_delta", text: "18C in Paris and rising, so" });
      await handle.push({ type: "tool_start", id: "t2", name: "get_weather", input: {} });
      mockBotApi.editMessageText.mockClear();

      await handle.push({
        type: "retract",
        text: "18C in Paris and rising, so",
        toolUseIds: ["t2"],
      });
      await handle.push({ type: "text_delta", text: "I ran out of room, ask me again." });
      await handle.finish();

      const bodies = mockBotApi.editMessageText.mock.calls.map((call) => String(call[2]));
      const final = expectDefined(bodies.at(-1), "final message body");
      expect(final).toContain("Let me check the weather.");
      expect(final).toContain("get_weather");
      expect(final).toContain("I ran out of room, ask me again.");
      expect(final).not.toContain("18C in Paris");
      // The retraction edits the message the turn was already writing into.
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("retracts an iteration whose text straddles its own tool banner", async () => {
      // The dropped iteration streamed prose, ran a tool, then streamed more.
      // Its text is therefore not contiguous in the live message — the banner
      // sits between the two halves — so the retraction has to be located by
      // stream structure. Searching the rendered message for the named text
      // finds nothing here, and treating "not found" as "already flushed"
      // takes the earlier iteration's narration down with it.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Let me check the weather.\n" });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await handle.push({ type: "tool_start", id: "t1", name: "get_weather", input: {} });
      await handle.push({ type: "text_delta", text: "Paris is " });
      await handle.push({ type: "tool_start", id: "t2", name: "get_forecast", input: {} });
      await handle.push({ type: "text_delta", text: "18C right now" });
      mockBotApi.editMessageText.mockClear();

      await handle.push({
        type: "retract",
        text: "Paris is 18C right now",
        toolUseIds: ["t2"],
      });
      await handle.push({ type: "text_delta", text: "I ran out of room, ask me again." });
      await handle.finish();

      const final = expectDefined(
        mockBotApi.editMessageText.mock.calls.map((call) => String(call[2])).at(-1),
        "final message body",
      );
      expect(final).toContain("Let me check the weather.");
      expect(final).toContain("get_weather");
      expect(final).toContain("I ran out of room, ask me again.");
      expect(final).not.toContain("Paris is");
      expect(final).not.toContain("18C right now");
      expect(final).not.toContain("get_forecast");
    });

    it("retracts a dropped iteration that streamed only a tool call", async () => {
      // `text` is empty and `toolUseIds` is not: the degrade landed before the
      // iteration produced prose. The banner belongs to a call that is not
      // persisted — and on a context overflow never ran at all — so it goes,
      // while the earlier iteration's banner and narration stay.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Checking the weather.\n" });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await handle.push({ type: "tool_start", id: "t1", name: "get_weather", input: {} });
      await handle.push({ type: "tool_start", id: "t2", name: "get_forecast", input: {} });
      mockBotApi.editMessageText.mockClear();

      await handle.push({ type: "retract", text: "", toolUseIds: ["t2"] });
      await handle.push({ type: "text_delta", text: "I ran out of room, ask me again." });
      await handle.finish();

      const final = expectDefined(
        mockBotApi.editMessageText.mock.calls.map((call) => String(call[2])).at(-1),
        "final message body",
      );
      expect(final).toContain("Checking the weather.");
      expect(final).toContain("get_weather");
      expect(final).toContain("I ran out of room, ask me again.");
      expect(final).not.toContain("get_forecast");
    });

    it("retracts the named text in append-only mode, where no banners exist", async () => {
      // Append-only mode never appends banners, so the buffer is text alone and
      // `toolUseIds` names nothing present. The text cut must still land in the
      // right place.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1", {
        chunkChars: 4000,
        allowEdits: false,
      });

      await handle.push({ type: "text_delta", text: "Let me check the weather.\n" });
      await handle.push({ type: "tool_start", id: "t1", name: "get_weather", input: {} });
      await handle.push({ type: "text_delta", text: "Paris is 18C" });

      await handle.push({ type: "retract", text: "Paris is 18C", toolUseIds: ["t1"] });
      await handle.push({ type: "text_delta", text: "I ran out of room." });
      await handle.finish();

      const sent = mockBotApi.sendMessage.mock.calls.map((call) => String(call[1])).join("\n");
      expect(sent).toContain("Let me check the weather.");
      expect(sent).toContain("I ran out of room.");
      expect(sent).not.toContain("Paris is 18C");
    });

    it("delivers the reply as plain text when its HTML render fails after a retraction", async () => {
      // A retraction cuts the body the throttled edits wrote out of the chunk,
      // so on a parse failure the message shows retracted text and the reply
      // has never been written. The plain-text retry has to write it.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "The three key points are: (1) the dep" });
      await handle.push({
        type: "retract",
        text: "The three key points are: (1) the dep",
        toolUseIds: [],
      });
      await handle.push({ type: "text_delta", text: "I hit a **wall** there, try again." });

      mockBotApi.editMessageText
        .mockReset()
        .mockRejectedValueOnce(new Error("can't parse entities"))
        .mockResolvedValue(true);
      await handle.finish();

      const bodies = mockBotApi.editMessageText.mock.calls.map((call) => String(call[2]));
      // First the HTML render, then the source markdown as plain text — the
      // user ends up with the reply either way, never the retracted fragment.
      expect(bodies[0]).toContain("<b>wall</b>");
      expect(bodies.at(-1)).toBe("I hit a **wall** there, try again.");
    });

    it("retry dedup returns same handle for same runId", async () => {
      const adapter = await createStreamingAdapter();
      const handle1 = await adapter.openStream("42", "run-1");
      const handle2 = await adapter.openStream("42", "run-1");

      expect(handle1).toBe(handle2);
    });

    it("different runId creates different handle", async () => {
      const adapter = await createStreamingAdapter();
      const handle1 = await adapter.openStream("42", "run-1");
      const handle2 = await adapter.openStream("42", "run-2");

      expect(handle1).not.toBe(handle2);
    });

    it("tool_start appends tool indicator", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Let me search." });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600);
      await handle.push({
        type: "tool_start",
        id: "t1",
        name: "web_search",
        input: {},
      });

      expect(mockBotApi.editMessageText).toHaveBeenCalledWith(
        42,
        100,
        "Let me search.\n🔍 web_search...\n",
      );
    });

    describe("4096-char overflow", () => {
      // Reproduces the prod MESSAGE_TOO_LONG class of failure: cumulative
      // streaming edits crossed Telegram's per-message char cap, every edit
      // after that point 400'd, and the conversation was marked errored.
      // The fix rotates to a fresh message before the cap; the assertions
      // here guard that every call to send/edit fits inside the cap.

      const TELEGRAM_CAP = 4096;

      it("a single push larger than the cap splits into multiple messages", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1");

        mockBotApi.sendMessage.mockClear();
        mockBotApi.editMessageText.mockClear();
        // Each paragraph is ~1100 chars; eight of them = ~8800 chars (>2x cap).
        // Paragraph boundaries are natural split points the boundary finder
        // should prefer.
        const para = `${"x".repeat(1100)}`;
        const big = Array(8).fill(para).join("\n\n");
        await handle.push({ type: "text_delta", text: big });
        await handle.finish();

        const sendCalls = mockBotApi.sendMessage.mock.calls;
        const editCalls = mockBotApi.editMessageText.mock.calls;
        // Multiple physical messages, not one 8800-char edit.
        expect(sendCalls.length + editCalls.length).toBeGreaterThan(1);
        for (const [, body] of sendCalls) {
          expect(typeof body).toBe("string");
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
        for (const [, , body] of editCalls) {
          expect(typeof body).toBe("string");
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
      });

      it("cumulative pushes that cross the cap rotate to a new message", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1");

        mockBotApi.sendMessage.mockClear();
        // Two messages so the test can observe the rotation: send first, then
        // a fresh sendMessage after the cap is crossed (with a different id).
        mockBotApi.sendMessage
          .mockResolvedValueOnce({ message_id: 100 })
          .mockResolvedValue({ message_id: 200 });
        mockBotApi.editMessageText.mockClear();

        // 4 chunks × 1100 chars = 4400 chars total, crosses the 4000-char
        // chunk target after the third push. Pre-compute the base time so
        // each iteration sets an absolute, predictable Date.now value
        // (re-reading Date.now inside the loop would compound with the spy
        // installed on the previous iteration).
        const chunk = "x".repeat(1100);
        const t0 = Date.now();
        for (let i = 0; i < 4; i++) {
          vi.spyOn(Date, "now").mockReturnValue(t0 + (i + 1) * 1000);
          await handle.push({ type: "text_delta", text: chunk });
        }
        await handle.finish();

        // At least one sendMessage after the original (a rotation happened),
        // and every payload fits the cap.
        expect(mockBotApi.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const [, body] of mockBotApi.sendMessage.mock.calls) {
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
        for (const [, , body] of mockBotApi.editMessageText.mock.calls) {
          expect((body as string).length).toBeLessThanOrEqual(TELEGRAM_CAP);
        }
      });

      it("a long code block split mid-fence renders every chunk inside <pre>", async () => {
        // The bug without rebalancing: head ends inside an open fence; tail
        // starts with raw body text (no opening fence). marked auto-closes
        // the head's fence at EOF (so head looks fine), but the tail renders
        // the continuation as paragraph text — code shows as plain prose
        // with no monospace formatting, and the trailing ``` becomes literal
        // backticks. Rebalancing restores the fence on the tail.
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1");

        mockBotApi.sendMessage.mockClear();
        mockBotApi.editMessageText.mockClear();
        mockBotApi.sendMessage
          .mockResolvedValueOnce({ message_id: 100 })
          .mockResolvedValue({ message_id: 200 });

        // Distinctive body content lets us locate the code in the rendered
        // output. 5000+ chars guarantees at least one mid-fence split.
        const body = "marker_token\n".repeat(400);
        await handle.push({
          type: "text_delta",
          text: `Output:\n\n\`\`\`python\n${body}\`\`\``,
        });
        await handle.finish();

        // Only HTML-rendered calls represent the finalized state of a chunk.
        // Plain-text edits during streaming carry no `parse_mode` and don't
        // assert anything about formatting — they get replaced by an HTML
        // render at finalize.
        const isHtml = (opts: unknown): boolean =>
          typeof opts === "object" &&
          opts !== null &&
          (opts as { parse_mode?: string }).parse_mode === "HTML";
        const renderedBodies = [
          ...mockBotApi.sendMessage.mock.calls
            .filter((c) => isHtml(c[2]))
            .map((c) => c[1] as string),
          ...mockBotApi.editMessageText.mock.calls
            .filter((c) => isHtml(c[3]))
            .map((c) => c[2] as string),
        ];
        // More than one rendered chunk (we split mid-fence) — proves the
        // rotation actually happened, not just a single oversized message.
        expect(renderedBodies.length).toBeGreaterThan(1);

        for (const b of renderedBodies) {
          if (b.includes("marker_token")) {
            // Body must be inside a <pre> block, not a <p> (which is what
            // marked emits when the continuation lacks an opening fence).
            const preBlock = b.match(/<pre[\s\S]*?<\/pre>/);
            expect(preBlock).not.toBeNull();
            expect(preBlock?.[0]).toContain("marker_token");
          }
          // No literal triple-backticks left over from an unclosed fence.
          expect(b).not.toMatch(/```/);
        }
      });
    });

    describe("append-only mode (allowEdits=false)", () => {
      it("never edits a message mid-stream — sub-chunk pushes accumulate silently", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1", {
          chunkChars: 4000,
          allowEdits: false,
        });

        await handle.push({ type: "text_delta", text: "hello" });
        await handle.push({ type: "text_delta", text: " world" });

        // No send and no edit until either chunk boundary or finish.
        expect(mockBotApi.sendMessage).not.toHaveBeenCalled();
        expect(mockBotApi.editMessageText).not.toHaveBeenCalled();

        await handle.finish();
        expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "hello world", {
          parse_mode: "HTML",
        });
        expect(mockBotApi.editMessageText).not.toHaveBeenCalled();
      });

      it("drops tool_start and status banners (no in-message hint to leak)", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1", {
          chunkChars: 4000,
          allowEdits: false,
        });

        await handle.push({ type: "text_delta", text: "thinking" });
        await handle.push({
          type: "tool_start",
          id: "t1",
          name: "web_search",
          input: {},
        });
        await handle.push({ type: "status", message: "still here" });
        await handle.push({ type: "text_delta", text: " done" });
        await handle.finish();

        // The banner text must not have made it into the final send body.
        expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "thinking done", {
          parse_mode: "HTML",
        });
      });

      it("kicks the typing heartbeat on first push and clears it on finish", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
          const adapter = await createStreamingAdapter();
          const handle = await adapter.openStream("42", "run-1", {
            chunkChars: 4000,
            allowEdits: false,
          });

          await handle.push({ type: "text_delta", text: "x" });
          // Immediate kick on first push.
          expect(mockBotApi.sendChatAction).toHaveBeenCalledWith(42, "typing");
          const initial = mockBotApi.sendChatAction.mock.calls.length;

          // Advance past one refresh interval (3500ms).
          await vi.advanceTimersByTimeAsync(4000);
          expect(mockBotApi.sendChatAction.mock.calls.length).toBeGreaterThan(initial);

          const beforeFinish = mockBotApi.sendChatAction.mock.calls.length;
          await handle.finish();
          // Another interval after finish — no more typing kicks once cleared.
          await vi.advanceTimersByTimeAsync(8000);
          expect(mockBotApi.sendChatAction.mock.calls.length).toBe(beforeFinish);
        } finally {
          vi.useRealTimers();
        }
      });

      it("rotates messages at the per-profile chunk target, not the default 4000", async () => {
        const adapter = await createStreamingAdapter();
        const handle = await adapter.openStream("42", "run-1", {
          chunkChars: 150,
          allowEdits: false,
        });

        // Two paragraphs, each ~120 chars — together they exceed the 150-char
        // target so the first must rotate before the second lands.
        const para = "a".repeat(120);
        await handle.push({ type: "text_delta", text: `${para}\n\n${para}` });
        await handle.finish();

        // First chunk shipped on overflow, second on finish — two sends, no edits.
        expect(mockBotApi.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(mockBotApi.editMessageText).not.toHaveBeenCalled();
      });
    });
  });

  describe("stream write failures", () => {
    beforeEach(() => {
      mockBotApi.sendMessage.mockReset().mockResolvedValue({ message_id: 100 });
      mockBotApi.editMessageText.mockReset().mockResolvedValue({});
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function createStreamingAdapter(): Promise<StreamingAdapter> {
      const { adapter } = await createAdapter();
      return adapter as unknown as StreamingAdapter;
    }

    /** Telegram's flood-wait answer, shaped as grammY's `GrammyError` carries it. */
    function tooManyRequests(retryAfterSeconds: number): Error {
      return Object.assign(
        new Error(
          `Call to 'editMessageText' failed! (429: Too Many Requests: retry after ${retryAfterSeconds})`,
        ),
        { error_code: 429, parameters: { retry_after: retryAfterSeconds } },
      );
    }

    const text = (t: string) => ({ type: "text_delta", text: t }) as const;

    it("waits out a 429 on a streaming edit, then writes the latest text", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      expect(await handle.push(text("Hello"))).toEqual(ok(undefined));

      mockBotApi.editMessageText.mockRejectedValueOnce(tooManyRequests(3));
      await vi.advanceTimersByTimeAsync(600);
      expect(await handle.push(text(" world"))).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);

      // Inside the wait nothing is written, however long past the edit interval.
      await vi.advanceTimersByTimeAsync(1000);
      expect(await handle.push(text("!"))).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);

      // Once retry_after has passed, the live message catches up unprompted.
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(2);
      expect(mockBotApi.editMessageText).toHaveBeenLastCalledWith(42, 100, "Hello world!");

      expect(await handle.finish()).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenLastCalledWith(42, 100, "Hello world!", {
        parse_mode: "HTML",
      });
    });

    it("retries a rate-limited final write once retry_after has passed", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValueOnce(tooManyRequests(2));

      const finishing = handle.finish();
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(await finishing).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(2);
      expect(mockBotApi.editMessageText).toHaveBeenLastCalledWith(42, 100, "done", {
        parse_mode: "HTML",
      });
    });

    it("fails the handle when retry_after exceeds the wait it will take", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValueOnce(tooManyRequests(3600));

      expect(await handle.finish()).toEqual(err(expect.stringContaining("retry after 3600")));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);
    });

    it("fails the handle when Telegram keeps rate-limiting a write", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValue(tooManyRequests(1));

      const finishing = handle.finish();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await finishing).toEqual(err(expect.stringContaining("429")));
      const attempts = mockBotApi.editMessageText.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(attempts);
    });

    /** A Bot API 5xx, shaped as grammY's `GrammyError` carries it. */
    function serverError(code: number): Error {
      return Object.assign(
        new Error(`Call to 'editMessageText' failed! (${code}: Internal Server Error)`),
        { error_code: code, parameters: {} },
      );
    }

    /** A failed request, shaped as grammY's `HttpError`. */
    function networkError(): Error {
      return Object.assign(new Error("Network request for 'editMessageText' failed!"), {
        name: "HttpError",
      });
    }

    it("retries a final write after a 5xx, then lands it", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValueOnce(serverError(502));

      const finishing = handle.finish();
      await vi.advanceTimersByTimeAsync(999);
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(await finishing).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(2);
      expect(mockBotApi.editMessageText).toHaveBeenLastCalledWith(42, 100, "done", {
        parse_mode: "HTML",
      });
    });

    it("fails the handle when 5xx outlast its retries", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValue(serverError(500));

      const finishing = handle.finish();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await finishing).toEqual(err(expect.stringContaining("500")));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(5);
    });

    it("retries a final write after a network error", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValueOnce(networkError());

      const finishing = handle.finish();
      await vi.advanceTimersByTimeAsync(1000);

      expect(await finishing).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(2);
    });

    /** Telegram's answer to an edit of a message that is gone. */
    function messageToEditNotFound(): Error {
      return Object.assign(
        new Error(
          "Call to 'editMessageText' failed! (400: Bad Request: message to edit not found)",
        ),
        { error_code: 400, parameters: {} },
      );
    }

    it("sends the final text as a new message when the message to edit is gone", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValueOnce(messageToEditNotFound());

      expect(await handle.finish()).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockBotApi.sendMessage).toHaveBeenLastCalledWith(42, "done", { parse_mode: "HTML" });
    });

    it("moves the stream to a new message when a preview finds its message gone", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("Hello"));
      mockBotApi.sendMessage.mockResolvedValueOnce({ message_id: 200 });
      mockBotApi.editMessageText.mockRejectedValueOnce(messageToEditNotFound());
      await vi.advanceTimersByTimeAsync(600);

      expect(await handle.push(text(" world"))).toEqual(ok(undefined));
      expect(mockBotApi.sendMessage).toHaveBeenLastCalledWith(42, "Hello world");
      expect(await handle.finish()).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenLastCalledWith(42, 200, "Hello world", {
        parse_mode: "HTML",
      });
    });

    it("fails the handle when the new message fails too", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("done"));
      mockBotApi.editMessageText.mockRejectedValueOnce(messageToEditNotFound());
      mockBotApi.sendMessage.mockRejectedValueOnce(
        new Error("Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)"),
      );

      expect(await handle.finish()).toEqual(err(expect.stringContaining("bot was blocked")));
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(2);
    });

    it("waits out a 5xx on a streaming edit, then writes the latest text", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1");
      await handle.push(text("Hello"));

      mockBotApi.editMessageText.mockRejectedValueOnce(serverError(502));
      await vi.advanceTimersByTimeAsync(600);
      expect(await handle.push(text(" world"))).toEqual(ok(undefined));

      await vi.advanceTimersByTimeAsync(500);
      expect(await handle.push(text("!"))).toEqual(ok(undefined));
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(mockBotApi.editMessageText).toHaveBeenCalledTimes(2);
      expect(mockBotApi.editMessageText).toHaveBeenLastCalledWith(42, 100, "Hello world!");
    });

    it("fails on a rejected write and leaves the run, so a retry opens a fresh handle", async () => {
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");
      mockBotApi.sendMessage.mockRejectedValueOnce(
        new Error("Call to 'sendMessage' failed! (403: Forbidden: bot was blocked by the user)"),
      );

      const blocked = err(expect.stringContaining("bot was blocked by the user"));
      expect(await handle.push(text("Hello"))).toEqual(blocked);
      // A failed handle reports its failure and writes nothing more.
      expect(await handle.push(text(" again"))).toEqual(blocked);
      const image = JSON.stringify({ path: "generated/a.jpg", mediaType: "image/jpeg" });
      expect(
        await handle.push({ type: "tool_result", name: "generate_image", output: image }),
      ).toEqual(blocked);
      expect(mockBotApi.sendPhoto).not.toHaveBeenCalled();
      expect(await handle.finish()).toEqual(blocked);
      expect(await handle.abort("LLM failed")).toEqual(blocked);
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockBotApi.editMessageText).not.toHaveBeenCalled();

      const retry = await adapter.openStream("42", "run-1");
      expect(retry).not.toBe(handle);
      expect(await retry.push(text("Hello"))).toEqual(ok(undefined));
      expect(mockBotApi.sendMessage).toHaveBeenLastCalledWith(42, "Hello");
    });

    it("reports an append-only reply its finish could not send, which it never showed", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1", {
        chunkChars: 4000,
        allowEdits: false,
      });
      await handle.push(text("the whole reply"));
      mockBotApi.sendMessage.mockRejectedValueOnce(
        new Error("Call to 'sendMessage' failed! (400: Bad Request: chat not found)"),
      );

      expect(await handle.finish()).toEqual(err(expect.stringContaining("chat not found")));
      expect(mockBotApi.editMessageText).not.toHaveBeenCalled();
    });

    describe("media across a run's handles", () => {
      const image = {
        type: "tool_result",
        name: "generate_image",
        output: JSON.stringify({ path: "generated/a.jpg", mediaType: "image/jpeg" }),
      } as const;

      it("does not resend a photo from the handle that replaces a failed one", async () => {
        const adapter = await createStreamingAdapter();
        const first = await adapter.openStream("42", "run-1");
        await first.push(text("Drawing"));
        await first.push(image);
        mockBotApi.editMessageText.mockRejectedValueOnce(
          new Error("Call to 'editMessageText' failed! (400: Bad Request: chat not found)"),
        );
        await vi.advanceTimersByTimeAsync(600);
        expect(await first.push(text("…"))).toEqual(err(expect.stringContaining("chat not found")));

        const retry = await adapter.openStream("42", "run-1");
        expect(retry).not.toBe(first);
        await retry.push(text("Drawing"));
        await retry.push(image);

        expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(1);
      });

      it("forgets a run's media once its stream finishes", async () => {
        const adapter = await createStreamingAdapter();
        const first = await adapter.openStream("42", "run-1");
        await first.push(image);
        expect(await first.finish()).toEqual(ok(undefined));

        await (await adapter.openStream("42", "run-1")).push(image);

        expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(2);
      });
    });

    it("keeps the handle for the run while a rate-limited write waits", async () => {
      // A retry that reopens the stream mid-wait joins the same live message.
      const adapter = await createStreamingAdapter();
      const handle = await adapter.openStream("42", "run-1");
      await handle.push(text("Hello"));
      mockBotApi.editMessageText.mockRejectedValueOnce(tooManyRequests(3));
      await vi.advanceTimersByTimeAsync(600);
      await handle.push(text(" world"));

      expect(await adapter.openStream("42", "run-1")).toBe(handle);
    });

    it("stops the typing heartbeat when the handle fails mid-stream", async () => {
      const handle = await (await createStreamingAdapter()).openStream("42", "run-1", {
        chunkChars: 100,
        allowEdits: false,
      });
      mockBotApi.sendMessage.mockRejectedValueOnce(new Error("Bad Request: chat not found"));

      const para = "a".repeat(80);
      expect(await handle.push(text(`${para}\n\n${para}`))).toEqual(
        err(expect.stringContaining("chat not found")),
      );
      const kicks = mockBotApi.sendChatAction.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockBotApi.sendChatAction).toHaveBeenCalledTimes(kicks);
    });
  });

  describe("generated images (mid-stream)", () => {
    async function createAdapterWithAttachments() {
      const transport = mockTransport({
        resolveSession: vi.fn().mockResolvedValue({
          id: "session-1",
          channelId: "tg-ch",
          platformAddress: "42",
          conversationId: "conv-1",
          status: "active",
          receive: "routed",
        }),
      });
      const attachments = mockAttachmentStore({
        download: vi.fn().mockResolvedValue(Buffer.from([7, 8, 9])),
      });
      const result = await setup({
        channelId: "tg-ch",
        credentials: { token: "fake" },
        transport,
        attachments,
        inngest: mockInngest(),
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
      });
      return { adapter: result.adapter as unknown as StreamingAdapter, attachments };
    }

    it("sends generated image via sendPhoto on generate_image tool_result", async () => {
      const { adapter, attachments } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: JSON.stringify({
          path: "generated/abc.jpg",
          mediaType: "image/jpeg",
        }),
      });

      expect(attachments.download).toHaveBeenCalledWith("generated/abc.jpg");
      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(1);
      const [chatId, inputFile] = mockBotApi.sendPhoto.mock.calls[0] ?? [];
      expect(chatId).toBe(42);
      const file = inputFile as { data: Buffer; filename: string };
      expect(file.data).toEqual(Buffer.from([7, 8, 9]));
      expect(file.filename).toBe("image.jpg");
    });

    it("dedups generate_image tool_result within the same run", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      const event = {
        type: "tool_result" as const,
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      };
      await handle.push(event);
      await handle.push(event);

      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(1);
    });

    it("retries the image after a failed sendPhoto (dedup only marks success)", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      const event = {
        type: "tool_result" as const,
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      };

      // First attempt: sendPhoto throws — dedup must not block the retry
      mockBotApi.sendPhoto.mockRejectedValueOnce(new Error("network blip"));
      await handle.push(event);
      // Second attempt (e.g., Inngest retry): should succeed
      await handle.push(event);

      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(2);
    });

    it("different runId delivers independently", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle1 = await adapter.openStream("42", "run-1");
      const handle2 = await adapter.openStream("42", "run-2");

      const event = {
        type: "tool_result" as const,
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      };
      await handle1.push(event);
      await handle2.push(event);

      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(2);
    });

    it("skips tool_result with isError=true", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: JSON.stringify({ path: "generated/x.jpg", mediaType: "image/jpeg" }),
        isError: true,
      });

      expect(mockBotApi.sendPhoto).not.toHaveBeenCalled();
    });

    it("ignores tool_result from other tools", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "web_search",
        output: JSON.stringify({ path: "something", mediaType: "image/jpeg" }),
      });

      expect(mockBotApi.sendPhoto).not.toHaveBeenCalled();
    });

    it("handles non-JSON output gracefully", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: "not json",
      });

      expect(mockBotApi.sendPhoto).not.toHaveBeenCalled();
    });

    it("strips the tool_start placeholder from accumulated text after photo delivery", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      // Emit the same sequence the agent loop produces: intro text,
      // tool_start (adds placeholder), tool_result (sends photo),
      // closing text, finish (final edit with HTML render).
      await handle.push({ type: "text_delta", text: "Here's the image." });
      await handle.push({ type: "tool_start", id: "t1", name: "generate_image", input: {} });
      await handle.push({
        type: "tool_result",
        name: "generate_image",
        output: JSON.stringify({ path: "generated/abc.jpg", mediaType: "image/jpeg" }),
      });
      await handle.push({ type: "text_delta", text: " Enjoy!" });
      await handle.finish();

      // The final edit must not contain the "🔍 generate_image..." placeholder.
      // (renderTelegramHtml may escape some characters; we only assert the
      // placeholder is gone and the surrounding text is preserved.)
      const lastEdit = mockBotApi.editMessageText.mock.calls.at(-1);
      const editedText = lastEdit?.[2] as string;
      expect(editedText).not.toContain("🔍 generate_image");
      expect(editedText).toContain("the image");
      expect(editedText).toContain("Enjoy");
    });

    it("deliver (batch path) sends images alongside text", async () => {
      const { adapter } = await createAdapter();
      await adapter.deliver("42", {
        text: "here it is",
        parseMode: "HTML",
        images: [
          { data: Buffer.from([1, 2, 3]), mediaType: "image/png" },
          { data: Buffer.from([4, 5, 6]), mediaType: "image/jpeg" },
        ],
      });

      expect(mockBotApi.sendMessage).toHaveBeenCalledWith(42, "here it is", {
        parse_mode: "HTML",
      });
      expect(mockBotApi.sendPhoto).toHaveBeenCalledTimes(2);
      const call0 = expectDefined(mockBotApi.sendPhoto.mock.calls[0], "sendPhoto call 0");
      const call1 = expectDefined(mockBotApi.sendPhoto.mock.calls[1], "sendPhoto call 1");
      expect((call0[1] as { filename: string }).filename).toBe("image.png");
      expect((call1[1] as { filename: string }).filename).toBe("image.jpg");
    });
  });

  describe("sendVoice", () => {
    it("delivers OGG via Telegram's sendVoice (voice-bubble UI)", async () => {
      const { adapter } = await createAdapter();
      const adapterAny = adapter as unknown as {
        sendVoice: (addr: string, audio: { audio: Buffer; mediaType: string }) => Promise<void>;
      };
      const audio = { audio: Buffer.from([1, 2, 3]), mediaType: "audio/ogg" };

      await adapterAny.sendVoice("42", audio);

      expect(mockBotApi.sendVoice).toHaveBeenCalledTimes(1);
      const [chatId, file] = mockBotApi.sendVoice.mock.calls[0]!;
      expect(chatId).toBe(42);
      expect((file as { filename: string }).filename).toBe("voice.ogg");
      expect((file as { data: Buffer }).data).toEqual(audio.audio);
      expect(mockBotApi.sendAudio).not.toHaveBeenCalled();
    });

    it("treats audio/opus the same as audio/ogg", async () => {
      const { adapter } = await createAdapter();
      const adapterAny = adapter as unknown as {
        sendVoice: (addr: string, audio: { audio: Buffer; mediaType: string }) => Promise<void>;
      };
      await adapterAny.sendVoice("42", {
        audio: Buffer.from([]),
        mediaType: "audio/opus",
      });
      expect(mockBotApi.sendVoice).toHaveBeenCalledTimes(1);
      expect(mockBotApi.sendAudio).not.toHaveBeenCalled();
    });

    it("falls back to sendAudio for non-Opus formats (e.g. MP3)", async () => {
      const { adapter } = await createAdapter();
      const adapterAny = adapter as unknown as {
        sendVoice: (addr: string, audio: { audio: Buffer; mediaType: string }) => Promise<void>;
      };
      await adapterAny.sendVoice("42", {
        audio: Buffer.from([0xff, 0xfb]),
        mediaType: "audio/mpeg",
      });
      expect(mockBotApi.sendAudio).toHaveBeenCalledTimes(1);
      expect(mockBotApi.sendVoice).not.toHaveBeenCalled();
    });
  });

  describe("deliver over Telegram's message cap", () => {
    it("splits a long reply into messages that each fit", async () => {
      const { adapter } = await createAdapter();
      const paragraph = `<b>${"x".repeat(1000)}</b>`;
      const text = Array.from({ length: 9 }, () => paragraph).join("\n\n");

      await adapter.deliver("42", { text, parseMode: "HTML" });

      const bodies = mockBotApi.sendMessage.mock.calls.map((call) => String(call[1]));
      expect(bodies.length).toBeGreaterThan(1);
      for (const body of bodies) expect(body.length).toBeLessThanOrEqual(4096);
      expect(bodies.join("\n\n")).toBe(text);
      for (const call of mockBotApi.sendMessage.mock.calls) {
        expect(call[2]).toEqual({ parse_mode: "HTML" });
      }
    });

    it("falls back to plain text for a part whose HTML the split broke", async () => {
      const { adapter } = await createAdapter();
      const text = `${"a".repeat(3000)}\n\n<pre>${"b".repeat(2000)}\n\n${"c".repeat(2000)}</pre>`;
      mockBotApi.sendMessage.mockImplementation(
        async (_chat: number, body: string, opts?: object) => {
          if (opts !== undefined && body.split("<pre>").length !== body.split("</pre>").length) {
            throw new Error("Bad Request: can't parse entities: unclosed tag");
          }
          return { message_id: 100 };
        },
      );

      await adapter.deliver("42", { text, parseMode: "HTML" });

      const sent = mockBotApi.sendMessage.mock.calls.map((call) => String(call[1]));
      expect(sent.join("")).toContain("c".repeat(2000));
      mockBotApi.sendMessage.mockReset().mockResolvedValue({ message_id: 100 });
    });
  });

  // deliver() (the non-streaming batch send path) has its own try/catch that
  // mirrors finish()'s HTML-parse fallback. Streaming already has a test
  // ("finish falls back to plain text when HTML parse fails"); this covers
  // the non-stream code path used by tool-result documents, voice fallbacks,
  // and any direct deliver() caller.
  describe("deliver HTML parse fallback", () => {
    it("retries with stripped tags when sendMessage throws 'can't parse entities'", async () => {
      const { adapter } = await createAdapter();
      mockBotApi.sendMessage
        .mockRejectedValueOnce(new Error("can't parse entities at byte offset 17"))
        .mockResolvedValueOnce({ message_id: 200 });

      await adapter.deliver("42", {
        text: "<b>bold</b> and <broken",
        parseMode: "HTML",
      });

      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(2);
      const first = mockBotApi.sendMessage.mock.calls[0];
      const second = mockBotApi.sendMessage.mock.calls[1];
      // First call: HTML attempt with parse_mode
      expect(first?.[2]).toEqual({ parse_mode: "HTML" });
      // Second call: stripped, no parse_mode option
      expect(second?.[1]).not.toContain("<b>");
      expect(second?.[1]).toContain("bold");
      expect(second?.[2]).toBeUndefined();
    });

    it("rethrows unrelated sendMessage errors (no silent swallow)", async () => {
      const { adapter } = await createAdapter();
      mockBotApi.sendMessage.mockRejectedValueOnce(new Error("403 Forbidden: bot was blocked"));

      await expect(adapter.deliver("42", { text: "anything", parseMode: "HTML" })).rejects.toThrow(
        "403 Forbidden",
      );
      // Did NOT fall through to a second attempt — the fallback is HTML-specific.
      expect(mockBotApi.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // Generated-document delivery via the streaming handle's `send_document`
  // tool_result path — mirrors the generated-image tests but exercises the
  // sendDocument code path that was uncovered.
  describe("generated documents (mid-stream)", () => {
    async function createAdapterWithAttachments(downloadImpl?: typeof Buffer.from) {
      const transport = mockTransport({
        resolveSession: vi.fn().mockResolvedValue({
          id: "session-1",
          channelId: "tg-ch",
          platformAddress: "42",
          conversationId: "conv-1",
          status: "active",
          receive: "routed",
        }),
      });
      const attachments = mockAttachmentStore({
        download: vi
          .fn()
          .mockResolvedValue(downloadImpl ? downloadImpl([1, 2, 3]) : Buffer.from([1, 2, 3])),
      });
      const result = await setup({
        channelId: "tg-ch",
        credentials: { token: "fake" },
        transport,
        attachments,
        inngest: mockInngest(),
        boundary: { promptTimeoutMs: 30000, minUserTurns: 3 },
      });
      return { adapter: result.adapter as unknown as StreamingAdapter, attachments };
    }

    it("sends generated document via sendDocument with the provided filename", async () => {
      const { adapter, attachments } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({
          path: "generated/report.pdf",
          mediaType: "application/pdf",
          name: "report.pdf",
        }),
      });

      expect(attachments.download).toHaveBeenCalledWith("generated/report.pdf");
      expect(mockBotApi.sendDocument).toHaveBeenCalledTimes(1);
      const [chatId, inputFile] = mockBotApi.sendDocument.mock.calls[0] ?? [];
      expect(chatId).toBe(42);
      const file = inputFile as { data: Buffer; filename: string };
      expect(file.data).toEqual(Buffer.from([1, 2, 3]));
      // The filename surfaces in Telegram's UI — must match what the LLM picked.
      expect(file.filename).toBe("report.pdf");
    });

    it("dedups send_document tool_result within the same run", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");
      const event = {
        type: "tool_result" as const,
        name: "send_document",
        output: JSON.stringify({
          path: "generated/x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
      };
      await handle.push(event);
      await handle.push(event);

      expect(mockBotApi.sendDocument).toHaveBeenCalledTimes(1);
    });

    it("retries the document after a failed sendDocument (dedup only marks success)", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");
      const event = {
        type: "tool_result" as const,
        name: "send_document",
        output: JSON.stringify({
          path: "generated/x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
      };

      mockBotApi.sendDocument.mockRejectedValueOnce(new Error("network blip"));
      await handle.push(event);
      await handle.push(event);

      expect(mockBotApi.sendDocument).toHaveBeenCalledTimes(2);
    });

    it("skips when payload is malformed (missing fields → parser returns null)", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      // Missing `name` — parser rejects.
      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({ path: "p", mediaType: "application/pdf" }),
      });
      // Not JSON at all.
      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: "not json",
      });

      expect(mockBotApi.sendDocument).not.toHaveBeenCalled();
    });

    it("skips tool_result with isError=true", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({
          path: "x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
        isError: true,
      });

      expect(mockBotApi.sendDocument).not.toHaveBeenCalled();
    });

    it("strips the send_document placeholder from accumulated text after delivery", async () => {
      const { adapter } = await createAdapterWithAttachments();
      const handle = await adapter.openStream("42", "run-1");

      await handle.push({ type: "text_delta", text: "Here's your file." });
      await handle.push({ type: "tool_start", id: "t1", name: "send_document", input: {} });
      await handle.push({
        type: "tool_result",
        name: "send_document",
        output: JSON.stringify({
          path: "generated/x.pdf",
          mediaType: "application/pdf",
          name: "x.pdf",
        }),
      });
      await handle.push({ type: "text_delta", text: " Done." });
      await handle.finish();

      const lastEdit = mockBotApi.editMessageText.mock.calls.at(-1);
      const editedText = lastEdit?.[2] as string;
      expect(editedText).not.toContain("🔍 send_document");
      expect(editedText).toContain("your file");
      expect(editedText).toContain("Done");
    });
  });
});
