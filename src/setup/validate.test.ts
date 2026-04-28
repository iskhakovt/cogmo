import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateAnthropicKey,
  validateGitHubPat,
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

describe("validateGitHubPat", () => {
  it("returns valid with login + id on 200", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { login: "cogmo-bot", id: 12345 }));
    const result = await validateGitHubPat("ghp_test");
    expect(result.valid).toBe(true);
    expect(result.meta?.login).toBe("cogmo-bot");
    // `id` is stringified in the meta so JSON round-trips don't lose
    // precision on >32-bit numerics.
    expect(result.meta?.id).toBe("12345");
  });

  it("calls api.github.com/user with the bearer header", async () => {
    const f = mockFetch(200, { login: "x", id: 1 });
    vi.stubGlobal("fetch", f);
    await validateGitHubPat("ghp_test");
    expect(f).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghp_test" }),
      }),
    );
  });

  it("returns invalid on 401", async () => {
    vi.stubGlobal("fetch", mockFetch(401));
    const result = await validateGitHubPat("bad");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it("returns invalid on 403 mentioning both scope + rate-limit possibilities", async () => {
    vi.stubGlobal("fetch", mockFetch(403));
    const result = await validateGitHubPat("scoped-too-narrow");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/scopes/i);
    expect(result.error).toMatch(/rate-limited/i);
  });

  it("returns invalid when /user response is missing login", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { id: 12345 }));
    const result = await validateGitHubPat("pat");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/login/);
  });

  it("returns invalid when /user response is missing id", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { login: "cogmo-bot" }));
    const result = await validateGitHubPat("pat");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/id/);
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", mockFetchError("ECONNREFUSED"));
    const result = await validateGitHubPat("pat");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
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
