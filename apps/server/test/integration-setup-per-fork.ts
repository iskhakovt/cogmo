/// <reference path="./vitest.d.ts" />

// Per-fork setup, run before any module imports.
//
// Each worker slot gets its own Inngest dev server. Functions subscribe by
// event name, so on a shared server every fork's app ran every other fork's
// events too — two forks racing through the same turn. `VITEST_POOL_ID` is
// unique among concurrently running workers, so no two live forks share one.

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { inject } from "vitest";

const endpoint = inject("inngestWorkers")[Number(process.env.VITEST_POOL_ID) - 1];
if (endpoint === undefined) {
  throw new Error(`no Inngest server for worker slot ${process.env.VITEST_POOL_ID}`);
}
process.env.INNGEST_BASE_URL = endpoint.baseUrl;
process.env.INNGEST_CONNECT_GATEWAY_URL = endpoint.gatewayUrl;
process.env.INNGEST_APP_ID = `cogmo-test-${randomUUID()}`;

// Each test file gets its own skills bare repo. Every `bootstrap()` brings
// the repo at `COGMO_SKILLS_PATH` to its expected state and, when the repo
// has an `origin`, registers it as the `skills` coding repo. On one shared
// directory, two forks booting on an empty repo collide in `git init
// --bare`, and a fork booting while another file's origin is attached
// inserts the `skills` row alongside that file's own boot.
process.env.COGMO_SKILLS_PATH = mkdtempSync(join(inject("skillsRoot"), "file-"));
