import { afterEach, describe, expect, it, vi } from "vitest";

// Keys resolved from `_FILE` exist only in `env`.
vi.mock("../env.js", () => ({
  env: {
    INNGEST_DEV: false,
    INNGEST_EVENT_KEY: "event-key-from-file",
    INNGEST_SIGNING_KEY: "0123abcd",
  },
}));

describe("inngest client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("takes its keys from the resolved env, not the SDK's process.env fallback", async () => {
    vi.stubEnv("INNGEST_EVENT_KEY", "");
    vi.stubEnv("INNGEST_SIGNING_KEY", "");

    const { inngest } = await import("./client.js");

    expect(inngest.eventKey).toBe("event-key-from-file");
    expect(inngest.signingKey).toBe("0123abcd");
  });
});
