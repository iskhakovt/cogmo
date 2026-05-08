import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateAnthropicKey,
  validateDaytonaApiKey,
  validateGitHubPat,
  validateHindsight,
  validateOpenAICompatibleKey,
  validateTavilyKey,
  validateTelegramToken,
} from "./validate.js";

// Daytona SDK mock — keep the real typed-error classes (the validator
// branches on `instanceof DaytonaAuthenticationError` etc.) and stub
// only the `Daytona` constructor so `.list()` is controllable per test.
// `vi.hoisted` because `vi.mock` is hoisted to the top of the module:
// state and class declared inline would be in the temporal dead zone
// when the factory runs.
const { daytonaListMock, daytonaConfigCalls } = vi.hoisted(() => ({
  daytonaListMock: vi.fn(),
  daytonaConfigCalls: [] as Array<unknown>,
}));
vi.mock("@daytonaio/sdk", async () => {
  const actual = await vi.importActual<typeof import("@daytonaio/sdk")>("@daytonaio/sdk");
  // `new Daytona(config)` must work, so the mock has to be constructible —
  // a class fits, while `vi.fn().mockImplementation(() => obj)` does not.
  class MockDaytona {
    list = daytonaListMock;
    constructor(config: unknown) {
      daytonaConfigCalls.push(config);
    }
  }
  return { ...actual, Daytona: MockDaytona };
});

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

describe("validateDaytonaApiKey", () => {
  afterEach(() => {
    daytonaListMock.mockReset();
    daytonaConfigCalls.length = 0;
  });

  it("returns valid on success", async () => {
    daytonaListMock.mockResolvedValue([]);
    const result = await validateDaytonaApiKey("dtn_test_api_key_abcdef0123456789");
    expect(result.valid).toBe(true);
  });

  it("returns invalid on DaytonaAuthenticationError", async () => {
    const { DaytonaAuthenticationError } = await import("@daytonaio/sdk");
    daytonaListMock.mockRejectedValue(new DaytonaAuthenticationError("nope"));
    const result = await validateDaytonaApiKey("bad_key_abcdef0123456789");
    expect(result).toEqual({ valid: false, error: "API key rejected (401 Unauthorized)" });
  });

  it("returns invalid on DaytonaAuthorizationError naming the org pin", async () => {
    const { DaytonaAuthorizationError } = await import("@daytonaio/sdk");
    daytonaListMock.mockRejectedValue(new DaytonaAuthorizationError("forbidden"));
    const result = await validateDaytonaApiKey("dtn_test_api_key_abcdef0123456789");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/403/);
    expect(result.error).toMatch(/organization/i);
  });

  it("returns invalid on connection failure", async () => {
    const { DaytonaConnectionError } = await import("@daytonaio/sdk");
    daytonaListMock.mockRejectedValue(new DaytonaConnectionError("ECONNREFUSED"));
    const result = await validateDaytonaApiKey("dtn_test_api_key_abcdef0123456789");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("forwards apiUrl + organizationId to the Daytona constructor", async () => {
    daytonaListMock.mockResolvedValue([]);
    await validateDaytonaApiKey("dtn_test_api_key_abcdef0123456789", {
      apiUrl: "https://daytona.example.com/api",
      organizationId: "org-7",
    });
    expect(daytonaConfigCalls).toEqual([
      {
        apiKey: "dtn_test_api_key_abcdef0123456789",
        apiUrl: "https://daytona.example.com/api",
        organizationId: "org-7",
      },
    ]);
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
