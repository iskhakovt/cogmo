/**
 * Image-gen provider construction. Mirrors `src/llm/resolver.ts` for text
 * LLMs: read a row, decrypt its secret, return an SDK adapter. Unlike the
 * LLM resolver there is no fallback chain — image gen has one provider per
 * model and a failed image gen surfaces directly to the LLM via the tool
 * result. See `design/image-generation.md` → Providers.
 */

import { createFal, type FalProvider as SdkFalProvider } from "@ai-sdk/fal";
import {
  createOpenAICompatible,
  type OpenAICompatibleProvider as SdkOpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";
import type { ImageProviderRow } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { VeniceImageProvider } from "./venice.js";

/** Optional per-provider `fetch` override; keyed by image_providers.type. */
export interface ImageProviderFetchOverrides {
  fal?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  openai_compatible?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  venice?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Discriminated union of constructed adapter instances. The `kind` matches
 * the row's `type` so consumers (the `generate_image` tool handler) can
 * pick between `provider.image(modelString)` (fal),
 * `provider.imageModel(modelString)` (openai-compatible), and
 * `provider.generate(...)` (venice) without further lookups.
 */
export type ImageProvider =
  | { kind: "fal"; row: ImageProviderRow; provider: SdkFalProvider }
  | { kind: "oai"; row: ImageProviderRow; provider: SdkOpenAICompatibleProvider }
  | { kind: "venice"; row: ImageProviderRow; provider: VeniceImageProvider };

/**
 * Build a single image provider from its row. Decrypts the secret via
 * `SecretsStore.getSecretById`. Throws if the secret is missing — every
 * `image_providers` row carries a NOT NULL FK to `secrets.id`, so a
 * missing decrypt typically means encrypted-at-rest key rotation lost a
 * row.
 *
 * The CHECK on `image_providers.base_url` plus the store-layer guard in
 * `createImageProvider` mean `row.baseUrl` is non-null when
 * `row.type` is `openai_compatible` or `venice`. The defensive null
 * checks inside those cases are for the type system — the runtime path
 * is unreachable.
 */
export async function buildImageProvider(
  row: ImageProviderRow,
  deps: {
    runInTx: Transactor;
    secretsStore: SecretsStore;
    fetchOverrides?: ImageProviderFetchOverrides;
  },
): Promise<ImageProvider> {
  const apiKey = await deps.runInTx((tx) => deps.secretsStore.getSecretById(tx, row.secretId));
  if (apiKey === undefined) {
    throw new Error(`image provider "${row.name}" references missing secret_id=${row.secretId}`);
  }
  switch (row.type) {
    case "fal":
      return {
        kind: "fal",
        row,
        provider: createFal({
          apiKey,
          ...(deps.fetchOverrides?.fal && { fetch: deps.fetchOverrides.fal }),
        }),
      };
    case "openai_compatible": {
      if (row.baseUrl === null) {
        // Defensive: the CHECK + store guard make this unreachable, but
        // typing surfaces the nullable column on every read.
        throw new Error(`image provider "${row.name}" is openai_compatible but has no base_url`);
      }
      return {
        kind: "oai",
        row,
        provider: createOpenAICompatible({
          name: row.name,
          apiKey,
          baseURL: row.baseUrl,
          ...(row.attrs.headers && { headers: row.attrs.headers }),
          ...(deps.fetchOverrides?.openai_compatible && {
            fetch: deps.fetchOverrides.openai_compatible,
          }),
        }),
      };
    }
    case "venice": {
      if (row.baseUrl === null) {
        // Defensive: the CHECK + store guard make this unreachable; same
        // posture as the openai_compatible arm above.
        throw new Error(`image provider "${row.name}" is venice but has no base_url`);
      }
      return {
        kind: "venice",
        row,
        provider: new VeniceImageProvider({
          apiKey,
          baseUrl: row.baseUrl,
          defaults: row.attrs.imageGenerationDefaults ?? {},
          ...(deps.fetchOverrides?.venice && { fetch: deps.fetchOverrides.venice }),
        }),
      };
    }
  }
}
