/// <reference path="./vitest.d.ts" />

// Per-file setup: runs before each integration test file's own modules load,
// so what it puts in `process.env` is what `src/env.ts` reads. Import app
// modules here only after the variables they read are set.
//
// Each file gets its own database, llmock and skills repo: files sharing a
// worker run one after another, so worker-scoped state would carry one file's
// rows and recordings into the next. Inngest is per worker slot, since each
// dev server is a container; each file registers under its own app id. See
// `.claude/rules/testing.md` → Integration Test Isolation.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, afterEach, expect, inject, type RunnerTestSuite } from "vitest";
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
    `llmock: ${drained.length} distinct request(s) matched nothing in ${cassette}\n\n${drained.join("\n\n")}`,
  );
}

function passedEveryTest(s: Readonly<RunnerTestSuite>): boolean {
  return s.tasks.every((t) =>
    t.type === "suite" ? passedEveryTest(t) : t.result?.state === "pass",
  );
}

// A miss fails the test that was running when it arrived.
afterEach(() => {
  const err = missError();
  if (err) throw err;
});

// Registered before the file's own hooks, so this runs after its teardown.
afterAll(async (_ctx, file) => {
  const unused = llmock.unusedFiles();
  await llmock.mock.stop();
  const err = missError();
  if (err) throw err;
  if (process.env.RECORD === "1") return;
  // Only a file that ran and passed every test has requested everything its
  // cassette holds, so a skip, a failure or a `-t` filter only warns.
  if (!passedEveryTest(file)) {
    if (unused.length > 0) {
      console.warn(`${cassette}: check waived; nothing requested ${unused.join(", ")}`);
    }
    return;
  }
  if (unused.length > 0) {
    throw new Error(
      `${cassette}: nothing requested ${unused.join(", ")}. A stale or duplicate recording: delete it, or re-record the suite.`,
    );
  }
});
