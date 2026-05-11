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
 * Two scenarios pin different wire surfaces:
 *   - `create-exec-delete` — happy path: inline `echo`, exit 0, single
 *     stdout WS frame. Covers create + process session +
 *     executeSessionCommand + WS log stream + exit-code lookup +
 *     cleanup.
 *   - `python-upload-fail` — unhappy path: `fs.uploadFiles` for a
 *     Python script that writes to stdout AND stderr then `sys.exit(2)`.
 *     Covers the multipart upload endpoint, stderr WS demux, multi-
 *     frame streaming, and non-zero exit code retrieval — three WS
 *     gaps the happy-path scenario doesn't reach.
 *
 * Fixture re-record trigger: a failing test in CI → SDK or wire
 * drifted since the last recording → operator re-records and commits.
 *
 * Gaps still not covered (future slices):
 *   - State-machine transitions taking real time (auto-stop,
 *     auto-archive, image-build progress) — these need the deferred
 *     nightly real-API job.
 *   - Per-account quirks (region routing, runner assignment).
 *   - `git.clone`, `refreshActivity`, `sandbox.start` (resume from
 *     stopped) — each one HTTP endpoint, low marginal value until we
 *     see drift in production.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Daytona } from "@daytonaio/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DaytonaMock, type DaytonaMockOptions } from "./daytona-mock.js";

const FIXTURE_DIR = "./test/fixtures/daytona";

/** Operator-set: `RECORD=1` flips this test (and fal/voice) into record mode. */
const IS_RECORD = process.env.RECORD === "1";

interface ScenarioHandle {
  /**
   * `true` when `RECORD=1` and `DAYTONA_API_KEY` are both set — the
   * scenario will proxy to real Daytona and write the fixture on
   * `endScenario()`.
   */
  readonly recordable: boolean;
  /**
   * Whether `test/fixtures/daytona/<name>.json` is on disk. Surfaced
   * separately from `runnable` so the marker test can identify which
   * dimension is missing on failure ("no fixture" vs "no record-mode
   * trigger").
   */
  readonly fixtureExists: boolean;
  /**
   * `recordable || fixtureExists`. When false, the scenario skips
   * with a visible marker assertion.
   */
  readonly runnable: boolean;
  /** Use in `beforeAll`. No-op when `runnable === false`. */
  init: () => Promise<void>;
  /** Use in `afterAll`. No-op when `init` was a no-op. */
  shutdown: () => Promise<void>;
  /**
   * Returns the live mock. Throws when called before `init()`
   * completes or after `shutdown()` runs — narrower contract than
   * exposing a nullable field, no per-call-site null check.
   */
  getMock: () => DaytonaMock;
}

/**
 * Build a per-scenario handle. The mock instance lives inside the
 * closure — callers can't reach into it accidentally, and the
 * vitest lifecycle is wired via the returned `init` / `shutdown`
 * functions. Subsumes the older `scenarioState()` + `createScenarioMock()`
 * pair so the two-step "compute mode → create mock" rule lives in
 * one place.
 */
function setupScenario(scenarioName: string): ScenarioHandle {
  const fixturePath = `${FIXTURE_DIR}/${scenarioName}.json`;
  const fixtureExists = existsSync(fixturePath);
  const recordable = IS_RECORD && !!process.env.DAYTONA_API_KEY;
  const runnable = recordable || fixtureExists;
  let mock: DaytonaMock | null = null;

  return {
    recordable,
    fixtureExists,
    runnable,
    init: async () => {
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
        mock.beginScenario(scenarioName);
      }
    },
    shutdown: async () => {
      if (mock) {
        await mock.stop();
        mock = null;
      }
    },
    getMock: () => {
      if (!mock) {
        throw new Error(
          `scenario "${scenarioName}": getMock() called before init() or after shutdown()`,
        );
      }
      return mock;
    },
  };
}

function makeDaytonaClient(mock: DaytonaMock, recordable: boolean): Daytona {
  return new Daytona({
    apiKey: recordable ? (process.env.DAYTONA_API_KEY ?? "") : "test-key",
    apiUrl: mock.url,
    ...(recordable &&
      process.env.DAYTONA_ORGANIZATION_ID && {
        organizationId: process.env.DAYTONA_ORGANIZATION_ID,
      }),
  });
}

const makeConformanceLabels = (): Record<string, string> => ({
  "cogmo.managed": "true",
  "cogmo.task": randomUUID(),
  "cogmo.role": "root",
  "cogmo.instance": "conformance",
});

// ─── Scenario 1: happy path ─────────────────────────────────────────

describe("Daytona conformance — create-exec-delete", () => {
  const scenario = setupScenario("create-exec-delete");

  beforeAll(scenario.init);
  afterAll(scenario.shutdown);

  it.skipIf(!scenario.runnable)(
    "create → exec-stream → delete round-trips through @daytonaio/sdk",
    async () => {
      const mock = scenario.getMock();
      const daytona = makeDaytonaClient(mock, scenario.recordable);

      // Labels are body-side only — they don't appear in URLs, so the
      // task-id can stay non-deterministic without breaking
      // (method, path) fixture matching.
      const sandbox = await daytona.create({
        image: "python:3.14-slim",
        labels: makeConformanceLabels(),
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

      if (scenario.recordable) {
        await mock.endScenario();
      }
    },
    120_000,
  );

  it.skipIf(scenario.runnable)(
    "fixture missing — set RECORD=1 + DAYTONA_API_KEY and re-run to capture",
    () => {
      // Marker: prints the gap loudly in CI output. Asserting both
      // dimensions separately so the failure message identifies which
      // one is the cause (no fixture vs. no record-mode trigger).
      expect(scenario.fixtureExists).toBe(false);
      expect(IS_RECORD).toBe(false);
    },
  );
});

// ─── Scenario 2: unhappy path (upload + stderr + non-zero exit) ─────

/**
 * Inline Python script uploaded via `fs.uploadFiles` and run via
 * `python3 /tmp/job.py`. Hand-picked to exercise three WS surfaces the
 * happy-path scenario doesn't:
 *   1. Multipart `fs.uploadFiles` REST endpoint.
 *   2. `onStderr` callback in `getSessionCommandLogs` — Daytona
 *      demuxes stdout vs stderr in the WS frame stream.
 *   3. `getSessionCommand` exit-code lookup for a non-zero exit code.
 *
 * The script content lives in the test source AND in the recorded
 * upload body. If you edit this string, re-record the fixture.
 */
const PYTHON_FAIL_SCRIPT = `\
import sys
print("hello-stdout")
sys.stderr.write("hello-stderr\\n")
sys.stderr.flush()
sys.exit(2)
`;

describe("Daytona conformance — python-upload-fail", () => {
  const scenario = setupScenario("python-upload-fail");

  beforeAll(scenario.init);
  afterAll(scenario.shutdown);

  it.skipIf(!scenario.runnable)(
    "upload python script → run → stderr + stdout streamed → exit 2",
    async () => {
      const mock = scenario.getMock();
      const daytona = makeDaytonaClient(mock, scenario.recordable);

      const sandbox = await daytona.create({
        image: "python:3.14-slim",
        labels: makeConformanceLabels(),
        autoStopInterval: 5,
      });

      // fs.uploadFiles — multipart POST /files/bulk-upload. Body is
      // multipart with a per-request random boundary; replay matches
      // by (method, path) only, so the boundary delta across record
      // and replay is harmless.
      await sandbox.fs.uploadFiles([
        {
          destination: "/tmp/job.py",
          source: Buffer.from(PYTHON_FAIL_SCRIPT, "utf8"),
        },
      ]);

      const sessionId = "conformance-session";
      await sandbox.process.createSession(sessionId);
      const start = await sandbox.process.executeSessionCommand(sessionId, {
        command: "python3 /tmp/job.py",
        runAsync: true,
      });
      expect(start.cmdId).toBeTruthy();
      const cmdId = start.cmdId ?? "";

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      await sandbox.process.getSessionCommandLogs(
        sessionId,
        cmdId,
        (chunk: string) => stdoutChunks.push(chunk),
        (chunk: string) => stderrChunks.push(chunk),
      );

      // stdout — the print() output landed in the stdout callback.
      expect(stdoutChunks.join("")).toContain("hello-stdout");
      // stderr — the sys.stderr.write() output landed in the SEPARATE
      // stderr callback. If Daytona's WS demux changes and stderr
      // started bleeding into stdout (or vice versa), this would fail.
      expect(stderrChunks.join("")).toContain("hello-stderr");

      // Non-zero exit lookup — different code path than the happy
      // case in `create-exec-delete`. Daytona occasionally reports
      // `exitCode=null` on the first GET when a fast-completed
      // command races against the toolbox's command-record write.
      // `vi.waitFor` re-runs the GET until the predicate holds (or
      // throws on a wall-clock deadline) so we actually exercise the
      // non-zero exit path — a conditional skip would silently pass
      // when the race triggered. Each retry re-runs the same SDK
      // call, so the record-mode fixture journals every iteration
      // and replay FIFO-matches the same sequence; the final
      // entry lands the populated exitCode.
      const finalCmd = await vi.waitFor(
        async () => {
          const got = await sandbox.process.getSessionCommand(sessionId, cmdId);
          if (got.exitCode === null || got.exitCode === undefined) {
            throw new Error("exit code not yet populated");
          }
          return got;
        },
        { timeout: 10_000, interval: 200 },
      );
      expect(finalCmd.exitCode).toBe(2);

      await sandbox.process.deleteSession(sessionId);
      await sandbox.delete();

      if (scenario.recordable) {
        await mock.endScenario();
      }
    },
    120_000,
  );

  it.skipIf(scenario.runnable)(
    "fixture missing — set RECORD=1 + DAYTONA_API_KEY and re-run to capture",
    () => {
      expect(scenario.fixtureExists).toBe(false);
      expect(IS_RECORD).toBe(false);
    },
  );
});
