/**
 * The auth probes against the real pinned server images.
 *
 * The unit tests fix the probe logic; these fix its premises — that a keyed
 * `inngest start` refuses `/v1/events` without a signing key and `/e/<key>`
 * under an unknown event key, that `inngest dev` refuses neither, and that
 * Hindsight's `ApiKeyTenantExtension` guards the bank list. An image bump
 * that moves any of those breaks here rather than silently turning the boot
 * check into a no-op.
 */
import { randomBytes } from "node:crypto";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BootCheckError, checkHindsightAuth, checkInngestAuth } from "./checks.js";

/** Same image as the dev server in `dev/containers.ts` → `inngest()`. */
const INNGEST_IMAGE = "mirror.gcr.io/inngest/inngest:v1.41.1";

describe("checkHindsightAuth — real Hindsight with ApiKeyTenantExtension", () => {
  it("passes with the configured key", async () => {
    await expect(
      checkHindsightAuth(fetch, inject("hindsightUrl"), inject("hindsightApiKey")),
    ).resolves.toBeUndefined();
  });

  it("rejects a key the server does not hold", async () => {
    await expect(checkHindsightAuth(fetch, inject("hindsightUrl"), "wrong-key")).rejects.toThrow(
      BootCheckError,
    );
  });
});

describe("checkInngestAuth — real Inngest", () => {
  const eventKey = randomBytes(16).toString("hex");
  const signingKey = randomBytes(32).toString("hex");
  let container: StartedTestContainer;
  let baseUrl: string;

  beforeAll(async () => {
    // `inngest start`: keyed, in-memory state, no UI — the production shape.
    container = await new GenericContainer(INNGEST_IMAGE)
      .withExposedPorts(8288)
      .withCommand([
        "inngest",
        "start",
        "--no-ui",
        "--event-key",
        eventKey,
        "--signing-key",
        signingKey,
      ])
      .withWaitStrategy(Wait.forHttp("/health", 8288))
      .withStartupTimeout(60_000)
      .start();
    baseUrl = `http://${container.getHost()}:${container.getMappedPort(8288)}`;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("passes against `inngest start` with the keys it was started with", async () => {
    await expect(
      checkInngestAuth(fetch, { baseUrl, dev: false, eventKey, signingKey }),
    ).resolves.toBeUndefined();
  });

  it("rejects a signing key the server does not hold", async () => {
    await expect(
      checkInngestAuth(fetch, {
        baseUrl,
        dev: false,
        eventKey,
        signingKey: randomBytes(32).toString("hex"),
      }),
    ).rejects.toThrow(/rejected INNGEST_SIGNING_KEY/);
  });

  it("rejects an event key the server does not hold", async () => {
    await expect(
      checkInngestAuth(fetch, { baseUrl, dev: false, eventKey: "not-a-key", signingKey }),
    ).rejects.toThrow(/rejected INNGEST_EVENT_KEY/);
  });

  it("refuses `inngest dev`, which accepts any key", async () => {
    await expect(
      checkInngestAuth(fetch, {
        baseUrl: inject("inngestBaseUrl"),
        dev: false,
        eventKey,
        signingKey,
      }),
    ).rejects.toThrow(/not enforcing keys/);
  });
});
