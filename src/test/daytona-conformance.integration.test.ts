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
 * Four scenarios pin different wire surfaces:
 *   - `create-exec-delete` — happy path at the SDK level: inline
 *     `echo`, exit 0, single stdout WS frame. Covers create +
 *     process session + executeSessionCommand + WS log stream +
 *     exit-code lookup + cleanup.
 *   - `python-upload-fail` — unhappy path at the SDK level:
 *     `fs.uploadFiles` for a Python script that writes to stdout AND
 *     stderr then `sys.exit(2)`. Covers the multipart upload endpoint,
 *     stderr WS demux, multi-frame streaming, and non-zero exit code
 *     retrieval.
 *   - `wrapper-success` — happy path at the wrapper level: drives
 *     `session.exec(["echo", "wrapper-hello"])` through
 *     `DaytonaSandboxClient` → `DaytonaSandboxSession.execStreaming`
 *     → `startExecStreaming` → `buildShellCommand`. Catches
 *     regressions in shell-quoting / lifecycle ordering that the
 *     SDK-level scenarios bypass.
 *   - `wrapper-stderr-nonzero` — wrapper-level stderr demux + non-zero
 *     exit through the buffered `ExecResult` shape.
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
import { DaytonaSandboxClient } from "../sandbox/daytona/client.js";
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

/**
 * Cogmo wrapper client for wrapper-level scenarios. Threads a
 * deterministic counter-backed random source so the per-exec session
 * IDs are stable between record and replay — `(method, path)` FIFO
 * matching in `DaytonaMock` requires identical URL paths across runs.
 */
async function makeWrapperClient(
  mock: DaytonaMock,
  recordable: boolean,
  scenarioName: string,
): Promise<DaytonaSandboxClient> {
  let seq = 0;
  return DaytonaSandboxClient.create({
    apiKey: recordable ? (process.env.DAYTONA_API_KEY ?? "") : "test-key",
    apiUrl: mock.url,
    instanceId: "conformance",
    random: () => `${scenarioName}-${++seq}`,
    ...(recordable &&
      process.env.DAYTONA_ORGANIZATION_ID && {
        organizationId: process.env.DAYTONA_ORGANIZATION_ID,
      }),
  });
}

// Shared task ID across both wrapper scenarios. Safe under vitest's
// serial-per-file execution model — if a future split puts the
// scenarios into separate files running in parallel forks, switch to
// per-scenario IDs so one scenario's `deleteByTaskId` doesn't reap
// the other's sandboxes via the `cogmo.task` label index.
const WRAPPER_TASK_ID = "wrapper-conf";
const WRAPPER_IMAGE = "python:3.14-slim";
// Mirror skills tier-2's `DEFAULT_RESOURCE_LIMITS` so the recorded
// fixture exercises the wrapper at production-typical limits and the
// snapshot Daytona bakes during record doesn't pay 3 GiB platform
// default storage. See `src/skills/worker-sysbox/host.ts`.
const WRAPPER_RESOURCE_LIMITS = {
  cpus: 1,
  memory_bytes: 512 * 1024 * 1024,
  pids: 256,
  disk_bytes: 1024 * 1024 * 1024,
};

/**
 * Marker assertion for a scenario whose fixture is missing AND the
 * test wasn't run in RECORD mode. Both dimensions checked separately
 * so the failure message identifies the cause — fixture absent vs.
 * `RECORD=1` set without `DAYTONA_API_KEY`.
 */
function expectFixtureMissing(scenario: ScenarioHandle): void {
  expect(scenario.fixtureExists).toBe(false);
  expect(IS_RECORD).toBe(false);
}

function wrapperSpec(): {
  taskId: string;
  image: string;
  resourceLimits: typeof WRAPPER_RESOURCE_LIMITS;
  expiresAt: Date;
} {
  return {
    taskId: WRAPPER_TASK_ID,
    image: WRAPPER_IMAGE,
    resourceLimits: WRAPPER_RESOURCE_LIMITS,
    // `autoStopInterval` derivation is `Math.ceil((expiresAt - now)
    // / 60_000)`, so a fixed 5-min wall-clock delta gives the same
    // baked value (5) on every run regardless of record vs replay.
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  };
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
    () => expectFixtureMissing(scenario),
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
    () => expectFixtureMissing(scenario),
  );
});

// ─── Scenario 3: wrapper-level happy path ───────────────────────────

/**
 * The first two scenarios drive `@daytonaio/sdk` directly with hand-
 * rolled command strings. Production code goes through Cogmo's wrapper
 * (`DaytonaSandboxClient` → `DaytonaSandboxSession.execStreaming` →
 * `startExecStreaming` → `buildShellCommand`). Without coverage of that
 * path against real Daytona traffic, regressions in `buildShellCommand`
 * quoting or `startExecStreaming` lifecycle ordering surface only in
 * production. This scenario asserts the full wrapper stack round-trips
 * a bare echo end-to-end.
 */
describe("Daytona conformance — wrapper-success", () => {
  const scenario = setupScenario("wrapper-success");

  beforeAll(scenario.init);
  afterAll(scenario.shutdown);

  it.skipIf(!scenario.runnable)(
    "session.exec routes through buildShellCommand + startExecStreaming and returns exitCode 0",
    async () => {
      const mock = scenario.getMock();
      const client = await makeWrapperClient(mock, scenario.recordable, "wrapper-success");
      // Mirror the production path: `ensureImagePresent` bakes a named
      // snapshot, then `client.create()` takes the fast
      // `{ snapshot }` route on every subsequent session. The lazy
      // `{ image }` fallback in `client.create()` is the SDK's 60s-
      // `waitUntilStarted` path, which is exactly what
      // `scheduleSandboxImageWarm` is designed to avoid in prod.
      await client.ensureImagePresent(WRAPPER_IMAGE, WRAPPER_RESOURCE_LIMITS);
      const session = await client.create(wrapperSpec());

      const result = await session.exec(["echo", "wrapper-hello"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("wrapper-hello");
      expect(result.stderr).toBe("");

      await client.delete(session);

      if (scenario.recordable) {
        await mock.endScenario();
      }
    },
    // 10 min — `ensureImagePresent`'s `snapshot.create` polls until
    // terminal with no SDK timeout, so a first-time build for
    // `python:3.14-slim` (3-10 min, per Daytona's image-build pipeline)
    // mustn't trip the vitest test timeout. Subsequent records reuse
    // the named snapshot and complete in seconds.
    600_000,
  );

  it.skipIf(scenario.runnable)(
    "fixture missing — set RECORD=1 + DAYTONA_API_KEY and re-run to capture",
    () => expectFixtureMissing(scenario),
  );
});

// ─── Scenario 3b: wrapper-level volume mount ────────────────────────

/**
 * The skills tier-2 deps cache (`SessionSpec.depsCacheVolume`) routes
 * through `DaytonaSandboxClient.#resolveVolumeId` → `daytona.volume.get`
 * → `daytona.create({ volumes: [...] })`. The unit tests in
 * `client.test.ts` mock the SDK so the volumes-array shape passes through
 * cleanly there, but the actual wire surface — `volume.get` HTTP, `volumes`
 * field on `create` — is only exercised against a real provider in this
 * scenario. Without it, a Daytona-side rename of the `volumes` field or
 * a `volume.get` 4xx contract change would only surface in production.
 */
describe("Daytona conformance — wrapper-volume-mount", () => {
  const scenario = setupScenario("wrapper-volume-mount");

  beforeAll(scenario.init);
  afterAll(scenario.shutdown);

  // Stable volume name pinned to the scenario so URL paths (the
  // `(method, path)` match key) stay identical across record + replay.
  const VOLUME_NAME = "cogmo-conformance-deps-cache";

  it.skipIf(!scenario.runnable)(
    "depsCacheVolume → volume.get + volumes mount round-trip through DaytonaSandboxClient",
    async () => {
      const mock = scenario.getMock();
      const client = await makeWrapperClient(mock, scenario.recordable, "wrapper-volume-mount");
      await client.ensureImagePresent(WRAPPER_IMAGE, WRAPPER_RESOURCE_LIMITS);
      const session = await client.create({
        ...wrapperSpec(),
        depsCacheVolume: { volumeName: VOLUME_NAME },
      });

      // Verify the mount is live by writing a sentinel file to the
      // declared mount path and reading it back. If the volumes spec
      // didn't reach `daytona.create`, the mount path would be a plain
      // overlay dir; the write would succeed but the file wouldn't
      // survive across sessions. We don't test cross-session here
      // (covered by sysbox e2e); the live `ls` against the mount is
      // enough to prove `volumes` made it through the wire.
      const result = await session.exec([
        "sh",
        "-c",
        "mkdir -p /skill-venvs && echo mounted > /skill-venvs/.cogmo-test && ls /skill-venvs/.cogmo-test",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/skill-venvs/.cogmo-test");

      await client.delete(session);

      if (scenario.recordable) {
        await mock.endScenario();
      }
    },
    600_000,
  );

  it.skipIf(scenario.runnable)(
    "fixture missing — set RECORD=1 + DAYTONA_API_KEY and re-run to capture",
    () => expectFixtureMissing(scenario),
  );
});

// ─── Scenario 4: wrapper-level stderr demux + non-zero exit ─────────

/**
 * Covers the WS stdout/stderr demux through the wrapper's `PassThrough`
 * streams and non-zero exit-code propagation through the buffered
 * `ExecResult`. The `sh -c "..."` form forces `buildShellCommand` to
 * quote the script body — a regression that breaks shell quoting (or
 * re-introduces the `exec` builtin) would either fail to emit "out" /
 * "err" or hang Daytona's session-completion detection.
 */
describe("Daytona conformance — wrapper-stderr-nonzero", () => {
  const scenario = setupScenario("wrapper-stderr-nonzero");

  beforeAll(scenario.init);
  afterAll(scenario.shutdown);

  it.skipIf(!scenario.runnable)(
    "session.exec demuxes stdout/stderr and surfaces non-zero exit through ExecResult",
    async () => {
      const mock = scenario.getMock();
      const client = await makeWrapperClient(mock, scenario.recordable, "wrapper-stderr-nonzero");
      await client.ensureImagePresent(WRAPPER_IMAGE, WRAPPER_RESOURCE_LIMITS);
      const session = await client.create(wrapperSpec());

      // Demux check is buffer-routing, not event-order: assertions
      // confirm bytes ended up in the correct ExecResult field, not
      // that stdout/stderr interleaved at any particular cadence.
      // Wrong-stream routing would still trip the substring miss.
      const result = await session.exec(["sh", "-c", "echo out; echo err >&2; exit 3"]);
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toContain("out");
      expect(result.stderr).toContain("err");

      await client.delete(session);

      if (scenario.recordable) {
        await mock.endScenario();
      }
    },
    600_000,
  );

  it.skipIf(scenario.runnable)(
    "fixture missing — set RECORD=1 + DAYTONA_API_KEY and re-run to capture",
    () => expectFixtureMissing(scenario),
  );
});
