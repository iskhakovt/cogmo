/**
 * Provider and channel validation helpers for the setup wizard.
 *
 * Each validator pings the provider's API to confirm the credential works.
 * Uses fetch() directly — no SDK imports, no side effects beyond the HTTP call.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  /** Provider-specific metadata (e.g., bot username for Telegram). */
  meta?: Record<string, string>;
}

/** Validate an Anthropic API key via GET /v1/models (free, no tokens consumed). */
export async function validateAnthropicKey(
  apiKey: string,
  baseUrl?: string,
): Promise<ValidationResult> {
  const url = `${baseUrl ?? "https://api.anthropic.com"}/v1/models`;
  try {
    const res = await fetch(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `Unexpected response: ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

/** Validate an OpenAI-compatible API key via GET /v1/models. */
export async function validateOpenAICompatibleKey(
  apiKey: string,
  baseUrl: string,
): Promise<ValidationResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Invalid API key" };
    return { valid: false, error: `Unexpected response: ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

/** Validate a Telegram bot token via getMe (free, returns bot username). */
export async function validateTelegramToken(token: string): Promise<ValidationResult> {
  const url = `https://api.telegram.org/bot${token}/getMe`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { valid: false, error: `Telegram API returned ${res.status}` };
    }
    const body = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (!body.ok) return { valid: false, error: "Telegram API returned ok: false" };
    return {
      valid: true,
      meta: { botUsername: body.result?.username ?? "unknown" },
    };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

/** Validate a Tavily API key by hitting the search endpoint with a tiny query. */
export async function validateTavilyKey(apiKey: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query: "test", max_results: 1 }),
    });
    if (res.ok) return { valid: true };
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }
    return { valid: false, error: `Unexpected response: ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

/**
 * Validate a GitHub fine-grained PAT via `GET https://api.github.com/user`.
 *
 * Returns the authenticated bot account login in `meta.login` so the wizard
 * can echo it back to the operator before they wire the key into a repo
 * (catches "I pasted the wrong account's PAT" before any push happens).
 */
export async function validateGitHubPat(pat: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "cogmo-setup",
      },
    });
    if (res.status === 401) return { valid: false, error: "PAT rejected (401 Unauthorized)" };
    if (res.status === 403) {
      return { valid: false, error: "PAT lacks the required scopes (403 Forbidden)" };
    }
    if (!res.ok) return { valid: false, error: `Unexpected response: ${res.status}` };
    const body = (await res.json()) as { login?: string };
    if (!body.login) return { valid: false, error: "GitHub /user response missing `login`" };
    return { valid: true, meta: { login: body.login } };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

/** Validate Hindsight server connectivity. */
export async function validateHindsight(url: string): Promise<ValidationResult> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`);
    if (res.ok) return { valid: true };
    return { valid: false, error: `Health check returned ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}
