/**
 * Pins the auth probes' premises against the pinned images: a keyed
 * `inngest start` refuses both anonymous probes, `inngest dev` refuses
 * neither, and Hindsight's `ApiKeyTenantExtension` guards the bank list.
 */
import { randomBytes } from "node:crypto";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { inngestKeyed } from "../../dev/containers.js";
import { workerInngestBaseUrl } from "../test/worker-inngest.js";
import {
  BootCheckError,
  checkHindsightAuth,
  checkInngestAuth,
  independentProbeContext,
} from "./checks.js";

const probeDeps = { fetch, ...independentProbeContext() };

describe("checkHindsightAuth — real Hindsight with ApiKeyTenantExtension", () => {
  it("passes with the configured key", async () => {
    await expect(
      checkHindsightAuth(probeDeps, inject("hindsightUrl"), inject("hindsightApiKey")),
    ).resolves.toBeUndefined();
  });

  it("rejects a key the server does not hold", async () => {
    await expect(
      checkHindsightAuth(probeDeps, inject("hindsightUrl"), "wrong-key"),
    ).rejects.toThrow(BootCheckError);
  });
});

describe("checkInngestAuth — real Inngest", () => {
  const eventKey = randomBytes(16).toString("hex");
  const signingKey = randomBytes(32).toString("hex");
  let container: StartedTestContainer;
  let baseUrl: string;

  beforeAll(async () => {
    container = await inngestKeyed({ eventKey, signingKey }).start();
    baseUrl = `http://${container.getHost()}:${container.getMappedPort(8288)}`;
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("passes against `inngest start` with the keys it was started with", async () => {
    await expect(
      checkInngestAuth(probeDeps, { baseUrl, dev: false, eventKey, signingKey }),
    ).resolves.toBeUndefined();
  });

  it("rejects a signing key the server does not hold", async () => {
    await expect(
      checkInngestAuth(probeDeps, {
        baseUrl,
        dev: false,
        eventKey,
        signingKey: randomBytes(32).toString("hex"),
      }),
    ).rejects.toThrow(/rejected INNGEST_SIGNING_KEY/);
  });

  it("rejects an event key the server does not hold", async () => {
    await expect(
      checkInngestAuth(probeDeps, { baseUrl, dev: false, eventKey: "not-a-key", signingKey }),
    ).rejects.toThrow(/rejected INNGEST_EVENT_KEY/);
  });

  it("refuses `inngest dev`, which accepts any key", async () => {
    await expect(
      checkInngestAuth(probeDeps, {
        baseUrl: workerInngestBaseUrl(),
        dev: false,
        eventKey,
        signingKey,
      }),
    ).rejects.toThrow(/not enforcing keys/);
  });
});
