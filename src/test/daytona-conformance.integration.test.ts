/// <reference path="../../test/vitest.d.ts" />

/**
 * Daytona conformance suite — runs `@daytonaio/sdk` against `DaytonaMock`.
 * Same shape as `fal-mock` and `openai-voice-mock` in `pipeline.integration.test.ts`:
 *
 *   - **Replay** (default, free in CI): `DaytonaMock` serves
 *     `test/fixtures/daytona/<scenario>.json` to the SDK. Per-PR cost
 *     is zero; the wire surface that the host-side
 *     `FakeDaytonaSandboxClient` (3c.1) DOESN'T model — SDK
 *     request/response shape, WS framing for
 *     `getSessionCommandLogs`, `getSessionCommand` exit-code
 *     semantics — is still exercised against bytes captured from the
 *     real Daytona API.
 *   - **Record** (`RECORD=1 DAYTONA_API_KEY=dty_... pnpm test:integration ...`):
 *     `DaytonaMock` proxies the SDK's traffic to the real Daytona API,
 *     journaling HTTP request/response pairs + WS frames into the
 *     fixture file. Same test body runs — what records is what replays.
 *
 * Fixture re-record trigger: this test fails in CI → SDK or wire
 * drifted since the last recording → operator re-records and commits.
 *
 * Gaps not covered (future slices):
 *   - State-machine transitions taking real time (auto-stop,
 *     auto-archive, image-build progress) — these need the deferred
 *     nightly real-API job.
 *   - Per-account quirks (region routing, runner assignment).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Daytona } from "@daytonaio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DaytonaMock, type DaytonaMockOptions } from "./daytona-mock.js";

const FIXTURE_DIR = "./test/fixtures/daytona";

/** Operator-set: `RECORD=1` flips this test (and fal/voice) into record mode. */
const IS_RECORD = process.env.RECORD === "1";

let mock: DaytonaMock | null = null;

afterAll(async () => {
  if (mock) await mock.stop();
});

describe("Daytona conformance — create-exec-delete", () => {
  const fixturePath = `${FIXTURE_DIR}/create-exec-delete.json`;
  const fixtureExists = existsSync(fixturePath);

  /**
   * Resolve the mock mode based on the env. Recording requires
   * `RECORD=1` + a real key; replay requires the fixture file. When
   * neither holds (PR run with no fixture yet) the test skips with a
   * marker assertion so the gap is visible in CI output.
   */
  const recordable = IS_RECORD && !!process.env.DAYTONA_API_KEY;
  const runnable = recordable || fixtureExists;

  beforeAll(async () => {
    if (!runnable) return;
    const opts: DaytonaMockOptions = recordable
      ? {
          mode: "record",
          fixturePath,
          upstreamUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
          upstreamApiKey: process.env.DAYTONA_API_KEY ?? "",
          ...(process.env.DAYTONA_ORGANIZATION_ID && {
            upstreamOrganizationId: process.env.DAYTONA_ORGANIZATION_ID,
          }),
        }
      : { mode: "replay", fixturePath };
    mock = await DaytonaMock.create(opts);
    if (recordable) {
      mock.beginScenario("create-exec-delete");
    }
  });

  it.skipIf(!runnable)(
    "create → exec-stream → delete round-trips through @daytonaio/sdk",
    async () => {
      if (!mock) throw new Error("mock not initialized");
      const daytona = new Daytona({
        apiKey: recordable ? (process.env.DAYTONA_API_KEY ?? "") : "test-key",
        apiUrl: mock.url,
        ...(recordable &&
          process.env.DAYTONA_ORGANIZATION_ID && {
            organizationId: process.env.DAYTONA_ORGANIZATION_ID,
          }),
      });

      // create-sandbox — SDK reads `id` + `toolboxProxyUrl` off the
      // response. Mock rewrites `toolboxProxyUrl` at record time so it
      // points at the mock itself; replay sees the rewritten URL.
      // Labels are body-side only — they don't appear in URLs, so the
      // task-id can stay non-deterministic without breaking
      // (method, path) fixture matching.
      const sandbox = await daytona.create({
        image: "python:3.14-slim",
        labels: {
          "cogmo.managed": "true",
          "cogmo.task": randomUUID(),
          "cogmo.role": "root",
          "cogmo.instance": "conformance",
        },
        autoStopInterval: 5,
      });
      expect(typeof sandbox.id).toBe("string");
      expect(sandbox.id.length).toBeGreaterThan(0);

      // exec session — covers process.createSession +
      // executeSessionCommand + getSessionCommandLogs (WS) +
      // getSessionCommand + deleteSession. `sessionId` is fixed (not
      // a UUID) because it appears in URL paths; fixture matching is
      // by `(method, path)`, so a random session id would miss on
      // every replay.
      const sessionId = "conformance-session";
      await sandbox.process.createSession(sessionId);
      const start = await sandbox.process.executeSessionCommand(sessionId, {
        command: "echo hello-from-record",
        runAsync: true,
      });
      expect(start.cmdId).toBeTruthy();
      const cmdId = start.cmdId ?? "";

      const lines: string[] = [];
      await sandbox.process.getSessionCommandLogs(
        sessionId,
        cmdId,
        (chunk: string) => lines.push(chunk),
        () => undefined,
      );
      // Daytona delivers log frames in chunks of varying sizes — join
      // and substring-match rather than asserting exact framing.
      expect(lines.join("")).toContain("hello-from-record");

      const finalCmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
      if (finalCmd.exitCode !== undefined && finalCmd.exitCode !== null) {
        expect(finalCmd.exitCode).toBe(0);
      }

      await sandbox.process.deleteSession(sessionId);
      await sandbox.delete();

      if (recordable && mock) {
        await mock.endScenario();
      }
    },
    120_000,
  );

  it.skipIf(runnable)(
    "fixture missing — set RECORD=1 + DAYTONA_API_KEY and re-run to capture",
    () => {
      // Marker test: prints the gap loudly in CI output instead of
      // silently skipping the whole describe block.
      expect(fixtureExists).toBe(false);
      expect(IS_RECORD).toBe(false);
    },
  );
});
