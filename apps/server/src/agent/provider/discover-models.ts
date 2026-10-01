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
 * gateways with bespoke auth flows); see `DiscoveryError`.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export interface DiscoveredModel {
  id: string;
  /** Optional, OpenRouter-only display name (`anthropic/claude-sonnet-4.6 → "Anthropic: Claude Sonnet 4.6"`). */
  name?: string;
  /** Optional inline limits — present for OpenRouter, absent everywhere else. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type DiscoveryError =
  /**
   * No list to be had: the endpoint is unreachable, answers 404, or answers
   * in a shape we can't read. The caller falls back to typing the id by hand.
   */
  | { kind: "unavailable"; message: string }
  /** The endpoint answered with an error status (auth, rate limit): worth a retry. */
  | { kind: "rejected"; status: number; message: string };

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

export async function discoverModels(
  args: DiscoverArgs,
): Promise<Result<DiscoveredModel[], DiscoveryError>> {
  if (args.type === "anthropic") {
    return discoverAnthropic(args.baseUrl, args.apiKey);
  }
  return discoverOpenAICompat(args.baseUrl, args.apiKey);
}

async function discoverAnthropic(
  baseUrl: string,
  apiKey: string,
): Promise<Result<DiscoveredModel[], DiscoveryError>> {
  const url = `${trimTrailingSlash(baseUrl)}/v1/models`;
  const body = await fetchModelList(url, {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });
  if (body.isErr()) return err(body.error);
  const parsed = AnthropicResponseSchema.safeParse(body.value);
  if (!parsed.success) return unavailable(`malformed /v1/models response from ${url}`);
  return ok(
    parsed.data.data.map((entry) => ({
      id: entry.id,
      ...(entry.display_name && { name: entry.display_name }),
    })),
  );
}

async function discoverOpenAICompat(
  baseUrl: string,
  apiKey: string,
): Promise<Result<DiscoveredModel[], DiscoveryError>> {
  const url = `${trimTrailingSlash(baseUrl)}/models`;
  const body = await fetchModelList(url, { Authorization: `Bearer ${apiKey}` });
  if (body.isErr()) return err(body.error);

  // Try the OpenRouter shape first — it's a strict superset of the OpenAI
  // shape, so a successful parse there means we get inline limits for free.
  // Only one of these branches should produce a `data` array with inline
  // `context_length` per row; the OpenAI shape never sets it.
  const orParsed = OpenRouterResponseSchema.safeParse(body.value);
  if (orParsed.success && orParsed.data.data.some((e) => e.context_length != null)) {
    return ok(
      orParsed.data.data.map((entry) => {
        const max = entry.top_provider?.max_completion_tokens ?? null;
        return {
          id: entry.id,
          ...(entry.name && { name: entry.name }),
          ...(entry.context_length != null && { contextWindow: entry.context_length }),
          ...(max != null && { maxOutputTokens: max }),
        };
      }),
    );
  }

  const oaParsed = OpenAIResponseSchema.safeParse(body.value);
  if (!oaParsed.success) return unavailable(`malformed /models response from ${url}`);
  return ok(oaParsed.data.data.map((entry) => ({ id: entry.id })));
}

/** GET `url` and read its JSON body. */
async function fetchModelList(
  url: string,
  headers: Record<string, string>,
): Promise<Result<unknown, DiscoveryError>> {
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch {
    return unavailable(`network error talking to ${url}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    if (res.status === 404) return unavailable(`${url} returned 404 (endpoint not exposed)`);
    return err({ kind: "rejected", status: res.status, message: `${url} returned ${res.status}` });
  }
  try {
    return ok(await res.json());
  } catch {
    return unavailable(`non-JSON response from ${url}`);
  }
}

function unavailable(message: string): Result<never, DiscoveryError> {
  return err({ kind: "unavailable", message });
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
