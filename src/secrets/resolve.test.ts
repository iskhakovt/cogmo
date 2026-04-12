import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSecretsStore } from "../test/factories.js";
import { createConfigResolver } from "./resolve.js";

const ENV_MAPPING = new Map([
  ["anthropic_api_key", "ANTHROPIC_API_KEY"],
  ["tavily_api_key", "TAVILY_API_KEY"],
]);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createConfigResolver", () => {
  it("returns DB value when present", async () => {
    const store = mockSecretsStore({
      getSecret: vi.fn().mockResolvedValue("db-key"),
    });
    const resolver = createConfigResolver({ secretsStore: store, envMapping: ENV_MAPPING });
    const value = await resolver.getSecret("anthropic_api_key");
    expect(value).toBe("db-key");
  });

  it("falls back to env when DB returns null", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    const store = mockSecretsStore({
      getSecret: vi.fn().mockResolvedValue(null),
    });
    const resolver = createConfigResolver({ secretsStore: store, envMapping: ENV_MAPPING });
    const value = await resolver.getSecret("anthropic_api_key");
    expect(value).toBe("env-key");
  });

  it("returns null when both DB and env miss", async () => {
    const store = mockSecretsStore({
      getSecret: vi.fn().mockResolvedValue(null),
    });
    const resolver = createConfigResolver({ secretsStore: store, envMapping: ENV_MAPPING });
    const value = await resolver.getSecret("anthropic_api_key");
    expect(value).toBeNull();
  });

  it("returns null for unknown secret name (no env mapping)", async () => {
    const store = mockSecretsStore({
      getSecret: vi.fn().mockResolvedValue(null),
    });
    const resolver = createConfigResolver({ secretsStore: store, envMapping: ENV_MAPPING });
    const value = await resolver.getSecret("unknown_key");
    expect(value).toBeNull();
  });

  it("DB takes precedence over env even when env is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    const store = mockSecretsStore({
      getSecret: vi.fn().mockResolvedValue("db-key"),
    });
    const resolver = createConfigResolver({ secretsStore: store, envMapping: ENV_MAPPING });
    const value = await resolver.getSecret("anthropic_api_key");
    expect(value).toBe("db-key");
  });
});
