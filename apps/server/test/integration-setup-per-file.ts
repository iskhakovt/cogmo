/// <reference path="./vitest.d.ts" />

// Per-file setup: runs before each integration test file's own modules load,
// so what it puts in `process.env` is what `src/env.ts` reads. Import app
// modules here only after the variables they read are set.
//
// A file's own resources are what keep suites apart. Files sharing a worker
// run one after another, so anything scoped to the worker would carry one
// file's rows and recordings into the next:
// - Database: a clone of the migrated template, seeded like a deployment, so
//   its default user, and with it that user's Hindsight bank, is the file's
//   own. Read it through `fileDatabaseUrl()` and `fileDefaultUserId()`.
// - llmock: serves the file's cassette (`test/llmock-setup.ts`), and fails the
//   file on a request the cassette cannot answer or, after a complete run, on
//   an interaction nothing requested. Read it through `fileLlmockUrl()`.
// - Skills bare repo: every `bootstrap()` brings the repo at
//   `COGMO_SKILLS_PATH` to its expected state and registers its `origin`.
//
// Inngest is the exception, one dev server per worker slot because each is a
// container. Functions subscribe by event name, so forks sharing a server
// would run each other's events. `VITEST_POOL_ID` is unique among
// concurrently running workers, and each file registers under its own app id.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import {
  afterAll,
  afterEach,
  expect,
  inject,
  type RunnerTestFile,
  type RunnerTestSuite,
} from "vitest";
import { cloneDatabase, seedDatabase } from "./integration-database.js";
import { createMock, suiteCassette } from "./llmock-setup.js";

const endpoint = inject("inngestWorkers")[Number(process.env.VITEST_POOL_ID) - 1];
if (endpoint === undefined) {
  throw new Error(`no Inngest server for worker slot ${process.env.VITEST_POOL_ID}`);
}
process.env.INNGEST_BASE_URL = endpoint.baseUrl;
process.env.INNGEST_CONNECT_GATEWAY_URL = endpoint.gatewayUrl;
process.env.INNGEST_APP_ID = `cogmo-test-${randomUUID()}`;

process.env.COGMO_SKILLS_PATH = mkdtempSync(join(inject("skillsRoot"), "file-"));

const testFile = expect.getState().testPath;
if (testFile === undefined) throw new Error("per-file setup ran outside a test file");
const suite = basename(testFile, ".integration.test.ts");

process.env.DATABASE_URL = await cloneDatabase(inject("postgresAdminUrl"), suite);
process.env.INTEGRATION_DEFAULT_USER_ID = await seedDatabase(inject("telegramMockUrl"));

const cassette = suiteCassette(testFile);
const misses: string[] = [];
const llmock = createMock(cassette, (description) => {
  misses.push(description);
  console.error(`[llmock ${suite}] ${description}`);
});
process.env.INTEGRATION_LLMOCK_URL = await llmock.mock.start();

function missError(): Error | undefined {
  const drained = [...new Set(misses.splice(0))];
  if (drained.length === 0) return undefined;
  return new Error(
    `llmock: ${drained.length} request(s) matched nothing in ${cassette}\n\n${drained.join("\n\n")}`,
  );
}

function passedEveryTest(s: Readonly<RunnerTestFile | RunnerTestSuite>): boolean {
  return s.tasks.every((t) =>
    t.type === "suite" ? passedEveryTest(t) : t.result?.state === "pass",
  );
}

let file: Readonly<RunnerTestFile> | undefined;

// A miss fails the test that was running when it arrived.
afterEach(({ task }) => {
  file = task.file;
  const err = missError();
  if (err) throw err;
});

// Registered before the file's own hooks, so this runs after its teardown.
afterAll(async () => {
  const unused = llmock.unusedFiles();
  await llmock.mock.stop();
  const err = missError();
  if (err) throw err;
  // Only a file that ran and passed every test has requested everything its
  // cassette holds, so a skip, a failure or a `-t` filter waives the check.
  if (process.env.RECORD === "1" || file === undefined || !passedEveryTest(file)) return;
  if (unused.length > 0) {
    throw new Error(
      `${cassette}: nothing requested ${unused.join(", ")}. A stale or duplicate recording: delete it, or re-record the suite.`,
    );
  }
});
