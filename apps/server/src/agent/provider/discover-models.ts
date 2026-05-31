/**
 * Provider model discovery — `GET /v1/models` against an OpenAI-compatible
 * or Anthropic endpoint, normalized to a common `DiscoveredModel` shape.
 *
 * Three response shapes in the wild:
 *
 *  - **OpenRouter** (`openai_compatible` + base URL contains `openrouter.ai`):
 *    Returns `{data: [{id, name, context_length, top_provider:
 *    {max_completion_tokens}, ...}]}`. Limits come back inline — no
 *    LiteLLM lookup needed.
 *  - **OpenAI / xAI / Together / Groq / vLLM / etc.** (generic
 *    OpenAI-compat): Returns `{data: [{id, object, created, owned_by}]}`.
 *    Just ids; the caller layers limits via the resolver.
 *  - **Anthropic**: Returns `{data: [{id, type, display_name, created_at}]}`
 *    via the Anthropic-native endpoint. Same shape as OpenAI from the
 *    discovery standpoint — just ids.
 *
 * Some custom endpoints don't expose `/v1/models` at all (corporate
 * gateways with bespoke auth flows). Callers should treat
 * {@link DiscoveryUnavailable} as "fall back to free-form text input"
 * rather than aborting.
 */

import { z } from "zod";

export interface DiscoveredModel {
  id: string;
  /** Optional, OpenRouter-only display name (`anthropic/claude-sonnet-4.6 → "Anthropic: Claude Sonnet 4.6"`). */
  name?: string;
  /** Optional inline limits — present for OpenRouter, absent everywhere else. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Thrown when discovery fails for a reason the caller should turn into
 * "type the model id by hand" UX (404, malformed response, network drop).
 * Distinct from a network/auth failure, which should propagate as a real
 * error.
 */
export class DiscoveryUnavailable extends Error {
  override readonly name = "DiscoveryUnavailable";
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
  }
}

const OpenRouterEntrySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    context_length: z.number().optional(),
    top_provider: z
      .object({
        max_completion_tokens: z.number().nullable().optional(),
      })
      .optional(),
  })
  .passthrough();

const OpenRouterResponseSchema = z.object({
  data: z.array(OpenRouterEntrySchema),
});

const OpenAIEntrySchema = z
  .object({
    id: z.string(),
  })
  .passthrough();

const OpenAIResponseSchema = z.object({
  data: z.array(OpenAIEntrySchema),
});

const AnthropicEntrySchema = z
  .object({
    id: z.string(),
    display_name: z.string().optional(),
  })
  .passthrough();

const AnthropicResponseSchema = z.object({
  data: z.array(AnthropicEntrySchema),
});

export interface DiscoverArgs {
  type: "anthropic" | "openai_compatible";
  baseUrl: string;
  apiKey: string;
}

export async function discoverModels(args: DiscoverArgs): Promise<DiscoveredModel[]> {
  if (args.type === "anthropic") {
    return discoverAnthropic(args.baseUrl, args.apiKey);
  }
  return discoverOpenAICompat(args.baseUrl, args.apiKey);
}

async function discoverAnthropic(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const url = `${trimTrailingSlash(baseUrl)}/v1/models`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
  } catch (err) {
    throw new DiscoveryUnavailable(`network error talking to ${url}`, err);
  }
  if (res.status === 404) {
    throw new DiscoveryUnavailable(`${url} returned 404 (endpoint not exposed)`);
  }
  if (!res.ok) {
    throw new Error(`Anthropic /v1/models returned ${res.status}`);
  }
  const body = await res.json();
  const parsed = AnthropicResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new DiscoveryUnavailable(`malformed /v1/models response from ${url}`, parsed.error);
  }
  return parsed.data.data.map((entry) => ({
    id: entry.id,
    ...(entry.display_name && { name: entry.display_name }),
  }));
}

async function discoverOpenAICompat(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const url = `${trimTrailingSlash(baseUrl)}/models`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    throw new DiscoveryUnavailable(`network error talking to ${url}`, err);
  }
  if (res.status === 404) {
    throw new DiscoveryUnavailable(`${url} returned 404 (endpoint not exposed)`);
  }
  if (!res.ok) {
    throw new Error(`OpenAI-compatible /models returned ${res.status}`);
  }
  const body = await res.json();

  // Try the OpenRouter shape first — it's a strict superset of the OpenAI
  // shape, so a successful parse there means we get inline limits for free.
  // Only one of these branches should produce a `data` array with inline
  // `context_length` per row; the OpenAI shape never sets it.
  const orParsed = OpenRouterResponseSchema.safeParse(body);
  if (orParsed.success && orParsed.data.data.some((e) => e.context_length != null)) {
    return orParsed.data.data.map((entry) => {
      const max = entry.top_provider?.max_completion_tokens ?? null;
      return {
        id: entry.id,
        ...(entry.name && { name: entry.name }),
        ...(entry.context_length != null && { contextWindow: entry.context_length }),
        ...(max != null && { maxOutputTokens: max }),
      };
    });
  }

  const oaParsed = OpenAIResponseSchema.safeParse(body);
  if (!oaParsed.success) {
    throw new DiscoveryUnavailable(`malformed /models response from ${url}`, oaParsed.error);
  }
  return oaParsed.data.data.map((entry) => ({ id: entry.id }));
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
