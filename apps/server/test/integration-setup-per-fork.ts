// Per-fork setup. Sets a unique Inngest app id before any module
// imports so the shared dev-server gateway doesn't round-robin
// events across peer workers.

import { randomUUID } from "node:crypto";

process.env.INNGEST_APP_ID = `cogmo-test-${randomUUID()}`;
