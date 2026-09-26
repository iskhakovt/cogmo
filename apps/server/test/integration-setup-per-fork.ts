/// <reference path="./vitest.d.ts" />

// Per-fork setup, run before any module imports.
//
// Each worker slot gets its own Inngest dev server. Functions subscribe by
// event name, so on a shared server every fork's app ran every other fork's
// events too — two forks racing through the same turn. `VITEST_POOL_ID` is
// unique among concurrently running workers, so no two live forks share one.

import { randomUUID } from "node:crypto";
import { inject } from "vitest";

const endpoint = inject("inngestWorkers")[Number(process.env.VITEST_POOL_ID) - 1];
if (endpoint === undefined) {
  throw new Error(`no Inngest server for worker slot ${process.env.VITEST_POOL_ID}`);
}
process.env.INNGEST_BASE_URL = endpoint.baseUrl;
process.env.INNGEST_CONNECT_GATEWAY_URL = endpoint.gatewayUrl;
process.env.INNGEST_APP_ID = `cogmo-test-${randomUUID()}`;

// DIAGNOSTIC ONLY — branch diag/mcp-pipeline-timeout.
import { afterAll as diagAfterAll, beforeAll as diagBeforeAll, expect as diagExpect } from "vitest";
import { diag } from "../src/diag.js";

diagBeforeAll(() => diag("file start", diagExpect.getState().testPath, process.env.INNGEST_BASE_URL));
diagAfterAll(() => diag("file end", diagExpect.getState().testPath));
