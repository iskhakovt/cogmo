import { describe, expect, it } from "vitest";
import { cacheDialectForBaseUrl } from "./cache-dialect.js";

describe("cacheDialectForBaseUrl", () => {
  // The same table as migration 0057's SQL (`src/db/migration-0057.test.ts`).
  it.each([
    ["https://openrouter.ai/api/v1", "openrouter"],
    ["https://api.openai.com/v1", "openai"],
    ["https://api.x.ai/v1", "xai"],
    ["HTTPS://API.X.AI/v1", "xai"],
    ["https://user:pw@api.x.ai:443/v1", "xai"],
    // Regional hosts: OpenRouter's in-region routing, OpenAI's data residency, xAI's US endpoint.
    ["https://eu.openrouter.ai/api/v1", "openrouter"],
    ["https://us.openrouter.ai/api/v1", "openrouter"],
    ["https://eu.api.openai.com/v1", "openai"],
    ["https://jp.api.openai.com/v1", "openai"],
    ["https://us.api.x.ai/v1", "xai"],
    ["https://api.deepseek.com/v1", "none"],
    ["https://openrouter.ai.evil.test/v1", "none"],
    ["https://evilopenrouter.ai/api/v1", "none"],
    ["https://api.openai.com.evil.test/v1", "none"],
    ["https://notapi.x.ai/v1", "none"],
    ["http://localhost:8000/v1", "none"],
    ["http://constructor/v1", "none"],
    ["not a url", "none"],
    ["", "none"],
  ])("%j → %s", (baseUrl, dialect) => {
    expect(cacheDialectForBaseUrl(baseUrl)).toBe(dialect);
  });
});
