import { boolean, integer, pgEnum, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { CacheDialectSchema } from "../../../llm/cache-dialect.js";
import { StoredExtraBodySchema } from "../../../llm/extra-body.js";
import { PrefixMismatchBehaviorSchema } from "../../../llm/prefix-mismatch-behavior.js";
import { logger } from "../../../logger.js";
import { secrets } from "../../../secrets/store/schema.js";

/**
 * LLM provider adapter discriminator. Maps to which `LlmProvider` class is
 * constructed in `buildProvider` (`src/llm/resolver.ts`). Adding a new value
 * is always a code change (new adapter constructor) AND a migration anyway,
 * so the enum cost equals the prior text-column cost while gaining
 * exhaustive `switch` checking.
 */
export const llmProviderType = pgEnum("llm_provider_type", ["anthropic", "openai_compatible"]);
export type LlmProviderTypeValue = (typeof llmProviderType.enumValues)[number];

/**
 * `llm_providers.attrs` — adapter-specific knobs. `cacheDialect` says which
 * caching and routing hints an OpenAI-compatible endpoint takes for a cache
 * intent; absent reads as `none`, and Anthropic rows never carry it.
 * `headers` sets extra default headers on the OpenAI SDK client (e.g.
 * `HTTP-Referer` for OpenRouter usage attribution). `prefixMismatchBehavior`,
 * on an Anthropic row, is what the API does with a replayed thinking block
 * whose prefix changed; absent keeps the account's default, and so does a
 * value the API doesn't take, which reads as absent with a warning: it is set
 * by hand, and a typo must not fail every model routed through the row.
 * Unknown keys are dropped on read, so a stray key never fails a provider
 * lookup.
 */
export const ProviderAttrsSchema = z.object({
  cacheDialect: CacheDialectSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  prefixMismatchBehavior: PrefixMismatchBehaviorSchema.optional().catch((ctx) => {
    // Once per read of the row, which the provider resolver caches per model.
    logger.warn(
      { prefixMismatchBehavior: ctx.value },
      "ignoring llm_providers.attrs.prefixMismatchBehavior: the API takes drop_block or error",
    );
    return undefined;
  }),
});
export type ProviderAttrs = z.infer<typeof ProviderAttrsSchema>;

export const llmProviders = pgTable("llm_providers", {
  id: pk(),
  name: text("name").notNull().unique(),
  type: llmProviderType("type").notNull(),
  baseUrl: text("base_url"), // NULL = SDK default endpoint
  secretId: uuid("secret_id")
    .notNull()
    .references(() => secrets.id),
  attrs: jsonbZod("attrs", ProviderAttrsSchema).notNull(),
  createdAt: ts(),
});

/**
 * For a given model, which providers can serve it and in what order.
 *
 * `contextWindow` / `maxOutputTokens` are nullable user-set overrides. The
 * resolver layers them: row override → bundled LiteLLM JSON snapshot →
 * conservative default. Operators only need to set them when LiteLLM doesn't
 * know the model id and the conservative default (128k/4k) is too small.
 *
 * `extraBody` is the operator's extra chat-completions request fields for the
 * model on an OpenAI-compatible provider; null sends only the adapter's own.
 * Writes are checked against `ExtraBodySchema`, reads against the more
 * lenient `StoredExtraBodySchema`. Anthropic rows never carry one.
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: pk(),
    model: text("model").notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => llmProviders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(), // 0 = primary, 1 = first fallback, ...
    userSelectable: boolean("user_selectable").notNull(), // false = internal-only (hidden from /model picker)
    contextWindow: integer("context_window"), // null → resolver falls back
    maxOutputTokens: integer("max_output_tokens"), // null → resolver falls back
    extraBody: jsonbZod("extra_body", StoredExtraBodySchema), // null → the adapter's fields only
    createdAt: ts(),
  },
  (t) => [
    unique("uq_model_provider").on(t.model, t.providerId),
    unique("uq_model_position").on(t.model, t.position),
  ],
);
