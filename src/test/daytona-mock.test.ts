/**
 * Unit tests for the Daytona record/replay mock. Covers the HTTP
 * surface in isolation: a hand-crafted fixture exercises the matching
 * algorithm, and a record-mode round-trip against a local "upstream"
 * stub proves the proxy + fixture-writing path.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyHandle } from "@daytonaio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DaytonaMock } from "./daytona-mock.js";

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "daytona-mock-test-"));
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/** Boot a throwaway HTTP server that stands in for upstream Daytona. */
async function startStubUpstream(
  handler: (
    path: string,
    method: string,
    body: string,
  ) => {
    status: number;
    bodyJson: unknown;
  },
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const result = handler(req.url ?? "/", req.method ?? "GET", body);
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.bodyJson));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("upstream stub address invalid");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("DaytonaMock", () => {
  describe("replay mode", () => {
    it("returns the recorded response for a matching (method, path)", async () => {
      const fixturePath = join(fixtureDir, "single-call.json");
      const fixture = {
        scenario: "single-call",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/sandbox/abc-123",
            request: {},
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              bodyJson: { id: "abc-123", state: "started" },
            },
          },
        ],
      };
      await writeFixture(fixturePath, fixture);

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const resp = await fetch(`${mock.url}/sandbox/abc-123`);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { id: string; state: string };
        expect(body).toEqual({ id: "abc-123", state: "started" });
      } finally {
        await mock.stop();
      }
    });

    it("matches multiple calls to the same (method, path) in FIFO order", async () => {
      const fixturePath = join(fixtureDir, "fifo.json");
      const fixture = {
        scenario: "fifo",
        calls: [
          {
            kind: "http",
            method: "POST",
            path: "/sandbox",
            request: {},
            response: { status: 200, bodyJson: { id: "first" } },
          },
          {
            kind: "http",
            method: "POST",
            path: "/sandbox",
            request: {},
            response: { status: 200, bodyJson: { id: "second" } },
          },
        ],
      };
      await writeFixture(fixturePath, fixture);

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const a = await (await fetch(`${mock.url}/sandbox`, { method: "POST" })).json();
        const b = await (await fetch(`${mock.url}/sandbox`, { method: "POST" })).json();
        expect(a).toEqual({ id: "first" });
        expect(b).toEqual({ id: "second" });
      } finally {
        await mock.stop();
      }
    });

    it("returns 503 when no fixture matches", async () => {
      const fixturePath = join(fixtureDir, "empty.json");
      await writeFixture(fixturePath, {
        scenario: "empty",
        calls: [],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const resp = await fetch(`${mock.url}/sandbox`);
        expect(resp.status).toBe(503);
        const text = await resp.text();
        expect(text).toMatch(/no fixture match/);
      } finally {
        await mock.stop();
      }
    });
  });

  describe("replay mode — path normalization", () => {
    it("matches when the request UUID differs from the recorded UUID", async () => {
      // Daytona echoes server-generated UUIDs back into subsequent
      // request paths (sandbox id, command id, etc.) — those UUIDs are
      // fresh every record run, so literal-path matching would never
      // hit. The mock normalizes both sides to `<UUID>` before compare.
      const fixturePath = join(fixtureDir, "replay-uuid-normalize.json");
      await writeFixture(fixturePath, {
        scenario: "uuid",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/sandbox/abc12345-1111-2222-3333-444444444444/state",
            request: {},
            response: { status: 200, bodyJson: { state: "started" } },
          },
        ],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const resp = await fetch(`${mock.url}/sandbox/deadbeef-9999-8888-7777-666666666666/state`);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({ state: "started" });
      } finally {
        await mock.stop();
      }
    });

    it("matches when cogmo session-IDs differ between record and replay", async () => {
      // Session IDs are `cogmo-<12hex-task-prefix>-<suffix>`. The
      // task-UUID prefix and suffix both drift between runs; the regex
      // normalizes the whole session ID to `cogmo-<SESSION>`.
      const fixturePath = join(fixtureDir, "replay-session-normalize.json");
      await writeFixture(fixturePath, {
        scenario: "session",
        calls: [
          {
            kind: "http",
            method: "POST",
            path: "/toolbox/sb-1/process/session/cogmo-aaaaaaaa-bbb-record-run-1/commands",
            request: {},
            response: { status: 200, bodyJson: { cmdId: "x" } },
          },
        ],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const resp = await fetch(
          `${mock.url}/toolbox/sb-1/process/session/cogmo-deadbeef-c0d-replay-run-99/commands`,
          { method: "POST" },
        );
        expect(resp.status).toBe(200);
      } finally {
        await mock.stop();
      }
    });

    it("session-ID normalization stops at path/query boundary", async () => {
      // The session-ID suffix matcher is `[^/?]+` — must stop at the
      // next path segment or the query string so adjacent path
      // segments don't get absorbed.
      const fixturePath = join(fixtureDir, "replay-session-boundary.json");
      await writeFixture(fixturePath, {
        scenario: "session-boundary",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/session/cogmo-aaaaaaaa-bbb-recorded/logs?follow=true",
            request: {},
            response: { status: 200, bodyJson: { ok: 1 } },
          },
        ],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        // Different session ID, but `/logs?follow=true` must still
        // line up — if the regex consumed across `/` or `?` the
        // suffix on either side would diverge and the match would
        // miss.
        const resp = await fetch(
          `${mock.url}/session/cogmo-deadbeef-fed-replayed/logs?follow=true`,
        );
        expect(resp.status).toBe(200);
      } finally {
        await mock.stop();
      }
    });

    it("applies pathNormalizations to both recorded and incoming paths", async () => {
      const fixturePath = join(fixtureDir, "replay-extra-normalize.json");
      await writeFixture(fixturePath, {
        scenario: "extra",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/skill-author-3/manifest",
            request: {},
            response: { status: 200, bodyJson: { name: "x" } },
          },
        ],
      });
      const mock = await DaytonaMock.create({
        mode: "replay",
        fixturePath,
        pathNormalizations: [{ pattern: /skill-author-\d+/g, replacement: "skill-author-<N>" }],
      });
      try {
        const resp = await fetch(`${mock.url}/skill-author-7/manifest`);
        expect(resp.status).toBe(200);
      } finally {
        await mock.stop();
      }
    });
  });

  describe("replay mode — body-bound headers", () => {
    it("strips recorded content-length so re-serialized body bytes don't trigger axios abort", async () => {
      // The recorded content-length is bound to the recorded byte
      // sequence; re-serializing the JSON produces a different byte
      // count (key ordering, whitespace), and a client that honors
      // the wrong content-length sees premature stream close. Pin
      // that the response Node actually sends does NOT carry the
      // recorded length.
      const fixturePath = join(fixtureDir, "replay-content-length.json");
      const huge = "x".repeat(9999);
      await writeFixture(fixturePath, {
        scenario: "content-length-strip",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/payload",
            request: {},
            response: {
              status: 200,
              headers: {
                "content-type": "application/json",
                "content-length": "99999",
                "transfer-encoding": "chunked",
                etag: 'W/"stale"',
                date: "Mon, 01 Jan 1970 00:00:00 GMT",
              },
              bodyJson: { payload: huge },
            },
          },
        ],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const resp = await fetch(`${mock.url}/payload`);
        expect(resp.status).toBe(200);
        // No stalled stream — fetch resolved a full body.
        const body = (await resp.json()) as { payload: string };
        expect(body.payload).toBe(huge);
        // Verify Node's recomputed content-length is consistent with the
        // bytes we actually sent (i.e. the recorded 99999 was discarded).
        const sentLen = resp.headers.get("content-length");
        if (sentLen !== null) {
          expect(Number(sentLen)).not.toBe(99999);
        }
        // ETag/date from the fixture must not survive the strip.
        expect(resp.headers.get("etag")).toBeNull();
        expect(resp.headers.get("date")).not.toBe("Mon, 01 Jan 1970 00:00:00 GMT");
      } finally {
        await mock.stop();
      }
    });
  });

  describe("replay mode — wrap-around", () => {
    it("wraps to find a match before the cursor when the cursor-side has no match", async () => {
      // Fixture order is [B, A]; replay calls A first. Cursor-first
      // scan from 0 finds A at i=1 (cursor advances past B). Then
      // calling B requires wrapping back to i=0.
      const fixturePath = join(fixtureDir, "replay-wrap-around.json");
      await writeFixture(fixturePath, {
        scenario: "wrap",
        calls: [
          {
            kind: "http",
            method: "POST",
            path: "/b",
            request: {},
            response: { status: 200, bodyJson: { which: "B" } },
          },
          {
            kind: "http",
            method: "POST",
            path: "/a",
            request: {},
            response: { status: 200, bodyJson: { which: "A" } },
          },
        ],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const a = await (await fetch(`${mock.url}/a`, { method: "POST" })).json();
        expect(a).toEqual({ which: "A" });
        const b = await (await fetch(`${mock.url}/b`, { method: "POST" })).json();
        expect(b).toEqual({ which: "B" });
      } finally {
        await mock.stop();
      }
    });

    it("re-matches an already-played entry after wrap (trade-off vs strict FIFO)", async () => {
      // Pinning the documented trade-off in findWrappedCall: there's
      // no consumed-set, so a fixture with a single call can satisfy
      // multiple identical requests via wrap. Strict FIFO would 503
      // here. If a future change tightens this, the test will fail
      // and force an explicit decision.
      const fixturePath = join(fixtureDir, "replay-wrap-duplicate.json");
      await writeFixture(fixturePath, {
        scenario: "wrap-dup",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/poll",
            request: {},
            response: { status: 200, bodyJson: { state: "ready" } },
          },
        ],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const first = await (await fetch(`${mock.url}/poll`)).json();
        const second = await (await fetch(`${mock.url}/poll`)).json();
        expect(first).toEqual({ state: "ready" });
        expect(second).toEqual({ state: "ready" });
      } finally {
        await mock.stop();
      }
    });
  });

  describe("replay mode — WS", () => {
    it("emits recorded server→client frames in order, then closes", async () => {
      const fixturePath = join(fixtureDir, "ws-stream.json");
      await writeFixture(fixturePath, {
        scenario: "ws-stream",
        calls: [
          {
            kind: "ws",
            path: "/toolbox/sb-1/process/session/s/commands/c/logs",
            frames: [
              { direction: "down", text: "hello\n" },
              { direction: "down", text: "world\n" },
              { direction: "close", code: 1000, reason: "" },
            ],
          },
        ],
      });

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const ws = new WebSocket(
          `${mock.url.replace(/^http/, "ws")}/toolbox/sb-1/process/session/s/commands/c/logs`,
        );
        const messages: string[] = [];
        const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
          ws.on("message", (data) => {
            messages.push(data.toString());
          });
          ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
          ws.on("error", reject);
        });
        const closeEvent = await closed;
        expect(messages).toEqual(["hello\n", "world\n"]);
        expect(closeEvent.code).toBe(1000);
      } finally {
        await mock.stop();
      }
    });

    // Wedge knob: when `faults` matches the incoming WS path, the mock
    // accepts the upgrade and does nothing — no frames, no close. This
    // is the regression-shape for the Daytona transport-wedge incident
    // (Daytona [#2513](https://github.com/daytonaio/daytona/issues/2513)
    // — no async exit notification). The fixture cursor is NOT
    // advanced, so non-wedged HTTP calls keep their FIFO order.
    it("ws-hold-open fault: accepts upgrade, no frames, no close (cursor not advanced)", async () => {
      const fixturePath = join(fixtureDir, "ws-wedge.json");
      // Fixture has one HTTP call AFTER the WS — this is the
      // cursor-not-advanced contract under test. If the wedge were
      // mistakenly consuming a cursor slot, the post-wedge GET below
      // would find nothing at the cursor and 503.
      await writeFixture(fixturePath, {
        scenario: "ws-wedge",
        calls: [
          {
            kind: "http",
            method: "GET",
            path: "/post-wedge-probe",
            request: {},
            response: {
              status: 200,
              headers: { "content-type": "application/json" },
              bodyJson: { ok: true },
            },
          },
        ],
      });

      const mock = await DaytonaMock.create({
        mode: "replay",
        fixturePath,
        faults: [{ wsPathPattern: /\/process\/session\/.*\/logs/, kind: "ws-hold-open" }],
      });
      try {
        const ws = new WebSocket(
          `${mock.url.replace(/^http/, "ws")}/toolbox/sb-1/process/session/s/command/c/logs?follow=true`,
        );
        // Wait for the upgrade to land, then verify no frames + no
        // close within a short window. 250ms is enough to catch a
        // bug where the wedge accidentally falls through to
        // `#replayWs` and emits frames immediately via queueMicrotask.
        await new Promise<void>((resolve, reject) => {
          ws.on("open", () => resolve());
          ws.on("error", reject);
        });
        let closed = false;
        const messages: string[] = [];
        ws.on("message", (data) => messages.push(data.toString()));
        ws.on("close", () => {
          closed = true;
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        expect(messages).toEqual([]);
        expect(closed).toBe(false);

        // Cursor unchanged: the post-wedge HTTP call still finds its
        // fixture entry. If the wedge mistakenly consumed cursor 0,
        // this would 503.
        const resp = await fetch(`${mock.url}/post-wedge-probe`);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toEqual({ ok: true });

        // Tear the WS down from the test side so vitest doesn't leak
        // the socket between tests.
        ws.close();
      } finally {
        await mock.stop();
      }
    });

    it("emits recorded binary frames as binary (isBinary === true) — PTY round-trip", async () => {
      // PTY terminal output arrives as binary frames; `data.toString()`
      // would UTF-8-decode it and mangle any non-UTF-8 byte sequence.
      // The `bytes` (base64) path preserves binary semantics end to end.
      const fixturePath = join(fixtureDir, "ws-binary.json");
      const ptyBytes = Buffer.from([0x1b, 0x5d, 0x30, 0x3b, 0x07, 0xc3, 0x28]); // ESC ] 0 ; BEL + invalid UTF-8
      await writeFixture(fixturePath, {
        scenario: "ws-binary",
        calls: [
          {
            kind: "ws",
            path: "/toolbox/sb-1/process/pty/sess-x/connect",
            frames: [
              { direction: "down", bytes: ptyBytes.toString("base64") },
              { direction: "close", code: 1000, reason: "" },
            ],
          },
        ],
      });

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const ws = new WebSocket(
          `${mock.url.replace(/^http/, "ws")}/toolbox/sb-1/process/pty/sess-x/connect`,
        );
        const received: Array<{ bytes: Buffer; isBinary: boolean }> = [];
        const closed = new Promise<void>((resolve, reject) => {
          ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
            const buf = rawDataToBuffer(data);
            received.push({ bytes: buf, isBinary });
          });
          ws.on("close", () => resolve());
          ws.on("error", reject);
        });
        await closed;
        expect(received).toHaveLength(1);
        expect(received[0]?.isBinary).toBe(true);
        expect(received[0]?.bytes.equals(ptyBytes)).toBe(true);
      } finally {
        await mock.stop();
      }
    });

    it("keeps WS open through SDK's sendInput, even when fixture has a trailing close", async () => {
      // Recordings of an interactive PTY session capture the trailing
      // `close` (Daytona signals exit via close-reason JSON). Without
      // synchronizing replay against the client's `sendInput` traffic,
      // the mock would emit every recorded frame back-to-back —
      // including the close — before the application calls
      // `sendInput`. The SDK's `handleClose` flips `connected = false`,
      // and the subsequent `sendInput` throws "PTY is not connected".
      // The mock must hold the close until the recorded `up` frames
      // have been consumed by real client traffic.
      const fixturePath = join(fixtureDir, "ws-pty-interactive.json");
      await writeFixture(fixturePath, {
        scenario: "ws-pty-interactive",
        calls: [
          {
            kind: "ws",
            path: "/toolbox/sb-1/process/pty/sess-x/connect",
            frames: [
              {
                direction: "down",
                text: JSON.stringify({ type: "control", status: "connected" }),
              },
              { direction: "up", bytes: Buffer.from("ls\n").toString("base64") },
              {
                direction: "down",
                bytes: Buffer.from("file.txt\n").toString("base64"),
              },
              {
                direction: "close",
                code: 1000,
                reason: JSON.stringify({ exitCode: 0 }),
              },
            ],
          },
        ],
      });

      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const ws = new WebSocket(
          `${mock.url.replace(/^http/, "ws")}/toolbox/sb-1/process/pty/sess-x/connect`,
        );
        const ptyChunks: Uint8Array[] = [];
        // PtyHandle's constructor types ws as the browser WebSocket
        // and handleResize as returning PtySessionInfo (from the
        // toolbox-api-client subpackage we don't import). The runtime
        // shape is fine — ws.send/close/readyState are what
        // setupWebSocketHandlers actually touches, and handleResize
        // never gets called in this flow.
        type PtyCtor = new (
          ws: unknown,
          handleResize: (cols: number, rows: number) => Promise<unknown>,
          handleKill: () => Promise<void>,
          onPty: (data: Uint8Array) => void | Promise<void>,
          sessionId: string,
        ) => PtyHandle;
        const pty = new (PtyHandle as unknown as PtyCtor)(
          ws,
          async () => ({}),
          async () => undefined,
          async (bytes) => {
            ptyChunks.push(bytes);
          },
          "sess-x",
        );
        await pty.waitForConnection();
        // This is the bug under test: without the fix, by the time
        // sendInput runs, the mock has already emitted the close
        // frame and the SDK's handleClose set `connected = false`.
        await pty.sendInput("ls\n");
        const result = await pty.wait();
        expect(result.exitCode).toBe(0);
        // The down PTY chunk made it through onPty.
        const text = Buffer.concat(ptyChunks.map((c) => Buffer.from(c))).toString("utf8");
        expect(text).toContain("file.txt");
      } finally {
        await mock.stop();
      }
    });

    it("rejects fixtures with both text and bytes set on one frame", async () => {
      const fixturePath = join(fixtureDir, "ws-both.json");
      await writeFixture(fixturePath, {
        scenario: "ws-both",
        calls: [
          {
            kind: "ws",
            path: "/toolbox/sb-1/anywhere",
            frames: [{ direction: "down", text: "hi", bytes: "aGk=" }],
          },
        ],
      });
      await expect(DaytonaMock.create({ mode: "replay", fixturePath })).rejects.toThrow();
    });

    it("returns 1011 when no WS fixture matches", async () => {
      const fixturePath = join(fixtureDir, "ws-empty.json");
      await writeFixture(fixturePath, {
        scenario: "ws-empty",
        calls: [],
      });
      const mock = await DaytonaMock.create({ mode: "replay", fixturePath });
      try {
        const ws = new WebSocket(`${mock.url.replace(/^http/, "ws")}/toolbox/x/nope`);
        const closeCode = await new Promise<number>((resolve) => {
          ws.on("close", (code) => resolve(code));
          ws.on("error", () => undefined);
        });
        expect(closeCode).toBe(1011);
      } finally {
        await mock.stop();
      }
    });
  });

  describe("record mode", () => {
    it("forwards to upstream, rewrites toolboxProxyUrl, persists scenario", async () => {
      const upstream = await startStubUpstream((path, method) => {
        if (method === "POST" && path === "/sandbox") {
          return {
            status: 200,
            bodyJson: {
              id: "sb-fake-1",
              state: "started",
              toolboxProxyUrl: "https://upstream.daytona.app/proxy",
            },
          };
        }
        return { status: 404, bodyJson: { error: "not_found" } };
      });
      const fixturePath = join(fixtureDir, "record-create.json");
      const mock = await DaytonaMock.create({
        mode: "record",
        fixturePath,
        upstreamUrl: upstream.url,
        upstreamApiKey: "real-key-redacted",
      });
      try {
        mock.beginScenario("create-rewrites-toolbox");
        const resp = await fetch(`${mock.url}/sandbox`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer fake-pre" },
          body: JSON.stringify({ image: "python:3.14" }),
        });
        const body = (await resp.json()) as { id: string; toolboxProxyUrl: string };
        // The SDK saw the rewritten URL pointing at the mock — toolbox
        // calls will land here too. URL is bare `/toolbox` (no
        // sandbox-id); the SDK appends the id itself per
        // Sandbox.js → `baseURL = baseUrl + id`.
        expect(body.id).toBe("sb-fake-1");
        expect(body.toolboxProxyUrl).toBe(`${mock.url}/toolbox`);
        await mock.endScenario();
      } finally {
        await mock.stop();
        await upstream.stop();
      }

      // Fixture contents: the placeholder is written to disk (not the
      // recording-time mock URL) so the fixture stays portable across
      // mock-port spawns. Replay materializes back to the live URL.
      const persisted = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        scenario: string;
        calls: Array<{
          method: string;
          path: string;
          response: { bodyJson?: { toolboxProxyUrl?: string } };
        }>;
      };
      expect(persisted.scenario).toBe("create-rewrites-toolbox");
      expect(persisted.calls).toHaveLength(1);
      const recorded = persisted.calls[0];
      expect(recorded?.method).toBe("POST");
      expect(recorded?.path).toBe("/sandbox");
      expect(recorded?.response.bodyJson?.toolboxProxyUrl).toBe("http://__daytona_mock__/toolbox");
    });

    it("journals binary WS frames as base64 bytes — PTY round-trip recording", async () => {
      // Stub upstream that speaks both HTTP and WS. POST /sandbox
      // returns a `toolboxProxyUrl` pointing at the stub itself so the
      // mock's toolbox map gets populated and routes the subsequent WS
      // upgrade back through us. Uses an OSC + invalid-UTF-8 byte
      // sequence as the PTY payload — `data.toString()` would mangle
      // these, so the assertion proves the new `bytes` path survives.
      const ptyBytes = Buffer.from([0x1b, 0x5d, 0x30, 0x07, 0xff, 0xfe]);
      const stub = await startStubUpstreamWithWs(ptyBytes);
      const fixturePath = join(fixtureDir, "record-pty-binary.json");
      const mock = await DaytonaMock.create({
        mode: "record",
        fixturePath,
        upstreamUrl: stub.url,
        upstreamApiKey: "real-key-redacted",
      });
      try {
        mock.beginScenario("pty-binary");
        // POST /sandbox populates the toolbox map with the stub's URL.
        const createResp = await fetch(`${mock.url}/sandbox`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: "anything" }),
        });
        expect(createResp.status).toBe(200);

        // Open a WS to the PTY connect path; the upstream sends one
        // binary frame and closes. The mock journals the frame as
        // `bytes` (base64) and forwards as binary to the client.
        const ws = new WebSocket(
          `${mock.url.replace(/^http/, "ws")}/toolbox/sb-pty-1/process/pty/sess-x/connect`,
        );
        const received: Array<{ buf: Buffer; isBinary: boolean }> = [];
        await new Promise<void>((resolve, reject) => {
          ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
            const buf = rawDataToBuffer(data);
            received.push({ buf, isBinary });
          });
          ws.on("close", () => resolve());
          ws.on("error", reject);
        });
        expect(received).toHaveLength(1);
        expect(received[0]?.isBinary).toBe(true);
        expect(received[0]?.buf.equals(ptyBytes)).toBe(true);
        await mock.endScenario();
      } finally {
        await mock.stop();
        await stub.stop();
      }

      // Fixture journaled the frame as base64 bytes — not as `text` —
      // and the base64 decodes back to the original byte sequence.
      const persisted = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        calls: Array<{
          kind: string;
          path: string;
          frames?: Array<{ direction: string; text?: string; bytes?: string }>;
        }>;
      };
      const wsCall = persisted.calls.find((c) => c.kind === "ws");
      expect(wsCall?.path).toBe("/toolbox/sb-pty-1/process/pty/sess-x/connect");
      const downFrames = wsCall?.frames?.filter((f) => f.direction === "down") ?? [];
      expect(downFrames).toHaveLength(1);
      expect(downFrames[0]?.text).toBeUndefined();
      expect(downFrames[0]?.bytes).toBeDefined();
      expect(Buffer.from(downFrames[0]?.bytes ?? "", "base64").equals(ptyBytes)).toBe(true);
    });

    it("strips Authorization header from recorded request — no real keys on disk", async () => {
      const upstream = await startStubUpstream(() => ({
        status: 200,
        bodyJson: { ok: true },
      }));
      const fixturePath = join(fixtureDir, "record-no-auth-leak.json");
      const mock = await DaytonaMock.create({
        mode: "record",
        fixturePath,
        upstreamUrl: upstream.url,
        upstreamApiKey: "sk-real-secret",
      });
      try {
        mock.beginScenario("redacts-auth");
        await fetch(`${mock.url}/sandbox/x`, {
          headers: { authorization: "Bearer client-token", "x-trace-id": "abc" },
        });
        await mock.endScenario();
      } finally {
        await mock.stop();
        await upstream.stop();
      }

      const text = readFileSync(fixturePath, "utf8");
      expect(text).not.toContain("sk-real-secret");
      expect(text).not.toContain("client-token");
      expect(text).toContain("x-trace-id");
    });

    it("scrubs known API keys (Anthropic, GitHub, OpenAI) from recorded request bodies", async () => {
      const anthropicKey =
        "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const githubToken = "gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const openaiKey = "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const upstream = await startStubUpstream(() => ({
        status: 200,
        bodyJson: { ok: true },
      }));
      const fixturePath = join(fixtureDir, "record-redacts-body-secrets.json");
      const mock = await DaytonaMock.create({
        mode: "record",
        fixturePath,
        upstreamUrl: upstream.url,
        upstreamApiKey: "sk-real-secret",
      });
      try {
        mock.beginScenario("redacts-body-secrets");
        await fetch(`${mock.url}/sandbox/x`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            env: { ANTHROPIC_API_KEY: anthropicKey, OPENAI_API_KEY: openaiKey },
            git: { password: githubToken },
          }),
        });
        await mock.endScenario();
      } finally {
        await mock.stop();
        await upstream.stop();
      }

      const text = readFileSync(fixturePath, "utf8");
      expect(text).not.toContain(anthropicKey);
      expect(text).not.toContain(githubToken);
      expect(text).not.toContain(openaiKey);
      expect(text).toContain("sk-ant-api03-REDACTED");
      expect(text).toContain("gho_REDACTED");
      expect(text).toContain("sk-REDACTED");
    });
  });
});

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

async function writeFixture(path: string, content: unknown): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(content));
}

/**
 * Stub upstream that speaks HTTP and WS on the same port. POST
 * `/sandbox` returns a `toolboxProxyUrl` pointing back at the stub so
 * the mock's toolbox map gets populated with a routable address; any
 * incoming WS upgrade emits one binary frame and closes.
 */
async function startStubUpstreamWithWs(
  binaryPayload: Buffer,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const { WebSocketServer } = await import("ws");
  const server: Server = createServer(async (req, res) => {
    // The toolboxProxyUrl reflects the stub's own URL so the mock's
    // forwarder can reach this same server for the WS upgrade.
    const ownUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.method === "POST" && req.url === "/sandbox") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "sb-pty-1",
          state: "started",
          toolboxProxyUrl: ownUrl,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket as import("node:net").Socket, head, (ws) => {
      ws.send(binaryPayload, { binary: true });
      ws.close(1000, "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub address invalid");
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        wss.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
