import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateAnthropicKey,
  validateHindsight,
  validateOpenAICompatibleKey,
  validateTavilyKey,
  validateTelegramToken,
} from "./validate.js";

function mockFetch(status: number, body?: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockFetchError(message: string) {
  return vi.fn().mockRejectedValue(new Error(message));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateAnthropicKey", () => {
  it("returns valid on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const result = await validateAnthropicKey("sk-ant-test");
    expect(result.valid).toBe(true);
  });

  it("returns invalid on 401", async () => {
    vi.stubGlobal("fetch", mockFetch(401));
    const result = await validateAnthropicKey("bad-key");
    expect(result).toEqual({ valid: false, error: "Invalid API key" });
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", mockFetchError("ECONNREFUSED"));
    const result = await validateAnthropicKey("sk-ant-test");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("uses custom base URL", async () => {
    const f = mockFetch(200);
    vi.stubGlobal("fetch", f);
    await validateAnthropicKey("key", "https://custom.api.com");
    expect(f).toHaveBeenCalledWith(
      "https://custom.api.com/v1/models",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "key" }) }),
    );
  });
});

describe("validateOpenAICompatibleKey", () => {
  it("returns valid on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const result = await validateOpenAICompatibleKey("key", "https://openrouter.ai/api/v1");
    expect(result.valid).toBe(true);
  });

  it("strips trailing slash from base URL", async () => {
    const f = mockFetch(200);
    vi.stubGlobal("fetch", f);
    await validateOpenAICompatibleKey("key", "https://api.openai.com/v1/");
    expect(f).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.any(Object));
  });
});

describe("validateTelegramToken", () => {
  it("returns valid with bot username on success", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { ok: true, result: { username: "cogmo_bot" } }));
    const result = await validateTelegramToken("123:ABC");
    expect(result.valid).toBe(true);
    expect(result.meta?.botUsername).toBe("cogmo_bot");
  });

  it("returns invalid on 401", async () => {
    vi.stubGlobal("fetch", mockFetch(401));
    const result = await validateTelegramToken("bad-token");
    expect(result.valid).toBe(false);
  });
});

describe("validateTavilyKey", () => {
  it("returns valid on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const result = await validateTavilyKey("tvly-test");
    expect(result.valid).toBe(true);
  });

  it("returns invalid on 401", async () => {
    vi.stubGlobal("fetch", mockFetch(401));
    const result = await validateTavilyKey("bad");
    expect(result).toEqual({ valid: false, error: "Invalid API key" });
  });
});

describe("validateHindsight", () => {
  it("returns valid on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const result = await validateHindsight("http://localhost:8888");
    expect(result.valid).toBe(true);
  });

  it("returns error on connection failure", async () => {
    vi.stubGlobal("fetch", mockFetchError("ECONNREFUSED"));
    const result = await validateHindsight("http://localhost:8888");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});
