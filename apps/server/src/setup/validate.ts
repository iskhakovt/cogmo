/**
 * Provider and channel validation helpers for the setup wizard.
 *
 * Each validator pings the provider's API to confirm the credential works.
 * `fetch()` direct for HTTP-API providers; the Daytona check goes through
 * the SDK because Daytona's REST surface isn't a documented stable contract.
 */

import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaAuthorizationError,
  DaytonaConnectionError,
  DaytonaError,
} from "@daytona/sdk";
import { disposeDaytona } from "../sandbox/daytona/dispose.js";
import { daytonaHealthProbe } from "../sandbox/daytona/probe.js";

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
      // GitHub returns 403 for both insufficient scopes AND secondary rate
      // limits / abuse detection. Don't claim "lacks scopes" definitively —
      // the operator-facing message would mislead troubleshooting when the
      // real cause is a rate limit.
      return {
        valid: false,
        error: "GitHub API returned 403 Forbidden (insufficient scopes or rate-limited)",
      };
    }
    if (!res.ok) return { valid: false, error: `Unexpected response: ${res.status}` };
    const body = (await res.json()) as { login?: string; id?: number };
    if (!body.login) return { valid: false, error: "GitHub /user response missing `login`" };
    if (typeof body.id !== "number") {
      return { valid: false, error: "GitHub /user response missing `id`" };
    }
    return { valid: true, meta: { login: body.login, id: String(body.id) } };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

/**
 * Validate a Claude Code subscription OAuth token (`claude setup-token`
 * output) by pinging `GET /v1/models` with `Authorization: Bearer …`.
 *
 * Per Anthropic's auth precedence, `CLAUDE_CODE_OAUTH_TOKEN` is sent as
 * a bearer token, so a 200 here confirms the token authenticates against
 * the Anthropic API. Free, no token consumed. 401 → invalid; anything
 * else → ambiguous (network, auth-scope mismatch on a non-`/messages`
 * endpoint, server-side hiccup) — reported as a soft warning so the
 * operator can decide whether to save anyway, matching the pattern used
 * elsewhere in the wizard.
 */
export async function validateClaudeCodeOauthToken(token: string): Promise<ValidationResult> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, error: "Token rejected (401 Unauthorized)" };
    return { valid: false, error: `Unexpected response: ${res.status}` };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

export interface DaytonaProbeOpts {
  /** Daytona Cloud URL when omitted (`https://app.daytona.io/api`). */
  apiUrl?: string;
  /** Required only when the API key spans multiple orgs. */
  organizationId?: string;
}

/**
 * Validate a Daytona API key by running the same `daytonaHealthProbe`
 * `DaytonaSandboxClient.healthCheck` uses, so the wizard fails on
 * whatever bootstrap will. Each typed `DaytonaError` subclass gets its
 * own actionable message; the base-class arm catches the rest
 * (`DaytonaRateLimitError`, `DaytonaTimeoutError`, `DaytonaConflictError`,
 * `DaytonaValidationError`, `DaytonaNotFoundError`) so a rate-limit hit
 * during repeated `cogmo setup` runs surfaces the SDK message instead
 * of the generic "Unexpected error" arm.
 *
 * The client is disposed before returning: its constructor opens an
 * authenticated event-stream socket, and a wizard user correcting a
 * mistyped key runs this more than once.
 *
 * Every failure — including a client that never got built — comes back as
 * a `ValidationResult`. Both callers (`wizard.ts` spinner, the
 * non-interactive validator set) render `error` and offer a retry; a
 * rejection would abort the setup flow instead.
 */
export async function validateDaytonaApiKey(
  apiKey: string,
  opts: DaytonaProbeOpts = {},
): Promise<ValidationResult> {
  const config: ConstructorParameters<typeof Daytona>[0] = { apiKey };
  if (opts.apiUrl) config.apiUrl = opts.apiUrl;
  if (opts.organizationId) config.organizationId = opts.organizationId;

  let daytona: Daytona;
  try {
    daytona = new Daytona(config);
  } catch (err) {
    // The constructor validates its config before it creates anything
    // disposable: a blank credential throws `DaytonaAuthenticationError`
    // and a non-finite `requestTimeoutMs` throws
    // `DaytonaInvalidArgumentError`, both ahead of the event dispatcher
    // whose socket `disposeDaytona` exists to close. So there is nothing to
    // dispose on this path — construction is what failed. The message is
    // generic rather than one of the HTTP-status arms below because no
    // request reached the API.
    return { valid: false, error: `Daytona client setup failed: ${(err as Error).message}` };
  }

  try {
    await daytonaHealthProbe(daytona);
    return { valid: true };
  } catch (err) {
    if (err instanceof DaytonaAuthenticationError) {
      return { valid: false, error: "API key rejected (401 Unauthorized)" };
    }
    if (err instanceof DaytonaAuthorizationError) {
      // Not the same as 401 — the key authenticated but lacks scope or
      // the org-id pin is wrong. Distinct message helps the operator
      // pick between rotating the key vs setting `DAYTONA_ORGANIZATION_ID`.
      return {
        valid: false,
        error: "API key rejected (403 Forbidden — wrong organization or insufficient scopes)",
      };
    }
    if (err instanceof DaytonaConnectionError) {
      return { valid: false, error: `Connection failed: ${err.message}` };
    }
    if (err instanceof DaytonaError) {
      return { valid: false, error: `Daytona API error: ${err.message}` };
    }
    return { valid: false, error: `Unexpected error: ${(err as Error).message}` };
  } finally {
    await disposeDaytona(daytona);
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
