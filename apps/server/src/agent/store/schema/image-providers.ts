import { sql } from "drizzle-orm";
import { boolean, check, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { jsonbZod, pk, ts } from "../../../db/helpers.js";
import { secrets } from "../../../secrets/store/schema.js";

/**
 * Image provider adapter discriminator. `fal` uses `@ai-sdk/fal` (no base
 * URL), `openai_compatible` uses `@ai-sdk/openai-compatible` against
 * `${base_url}/images/generations`, `venice` uses a hand-rolled adapter
 * against Venice.ai's native `/image/generate` endpoint (Venice's
 * OpenAI-compat path strict-rejects its own bespoke knobs like
 * `safe_mode` / `negative_prompt`). See `design/image-generation.md` →
 * Providers.
 */
export const imageProviderType = pgEnum("image_provider_type", [
  "fal",
  "openai_compatible",
  "venice",
]);
export type ImageProviderTypeValue = (typeof imageProviderType.enumValues)[number];

/**
 * Provider-level image-generation defaults. Adapter-specific knobs the
 * operator pins for every call (the LLM never sees or chooses these).
 * Today shaped by Venice's native API but the field name is provider-neutral
 * so future providers can layer their own defaults under the same key without
 * another migration.
 *
 * - `safe_mode`: Venice defaults to `true` (applies a blur); set
 *   `false` to disable blur. When `safe_mode` is false the adapter throws on
 *   `x-venice-is-blurred: true` — an unwanted blur is a failed generation,
 *   not a delivery target.
 * - `cfg_scale`: classifier-free guidance strength (Venice). Lower = looser
 *   adherence to the prompt; higher = tighter. Venice's documented range is
 *   0–20.
 * - `hide_watermark`: strip the Venice watermark when supported.
 * - `style_preset`: Venice style preset name (e.g. `"3D Model"`,
 *   `"Anime"`). Free-form because the upstream list evolves.
 *
 * **Forward shape decision.** The current schema is flat — every field
 * sits at the top level. That's correct for one provider with a clean
 * keyspace. When a second provider's defaults land (Replicate, OpenAI
 * gpt-image-*, Together image, etc.), two options open up:
 *   (a) Stay flat. Works if the new fields don't collide with venice's.
 *       Risk: a future provider's `cfg_scale` with different semantics
 *       or range — same name, different meaning — would corrupt rows
 *       silently on swap or be unenforceable at the schema layer.
 *   (b) Namespace: `{ venice?: {...}, replicate?: {...} }`. Buys
 *       isolation at the cost of one extra level of indirection in
 *       every adapter that reads its slice. Adapters become "look up
 *       my namespace" rather than "spread my fields."
 * Pick (b) the moment any name collision is plausible or a second
 * provider adds three or more knobs. Pick (a) if the second provider
 * adds one or two with names obviously distinct from venice's.
 */
export const ImageGenerationDefaultsSchema = z.object({
  safe_mode: z.boolean().optional(),
  cfg_scale: z.number().min(0).max(20).optional(),
  hide_watermark: z.boolean().optional(),
  style_preset: z.string().optional(),
});
export type ImageGenerationDefaults = z.infer<typeof ImageGenerationDefaultsSchema>;

/**
 * `image_providers.attrs` — adapter-specific knobs. `headers` sets extra
 * default headers on the OpenAI-compatible SDK client (e.g. for tenant
 * routing or usage attribution). `imageGenerationDefaults` carries the
 * provider-level call defaults the operator wants pinned (see
 * `ImageGenerationDefaultsSchema`). Fal has no documented use today.
 */
export const ImageProviderAttrsSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  imageGenerationDefaults: ImageGenerationDefaultsSchema.optional(),
});
export type ImageProviderAttrs = z.infer<typeof ImageProviderAttrsSchema>;

/**
 * `image_models.capabilities` — per-model knob bag. Read by the LLM (via the
 * tool description) and by the tool handler (to validate the LLM's pick).
 *
 * `aspectRatios` — ratios the LLM may pick for this model. Absent or empty
 *   array → the model accepts no custom aspect ratio (fixed-size models like
 *   recraft-v3 character/embedding variants). Both states are treated
 *   identically by the handler: if the LLM still passes `aspectRatio`, the
 *   handler returns a text error the LLM can recover from (re-pick a ratio
 *   or a different model) rather than dropping it silently.
 * `seed` — whether `seed` is honored. Absent treated as false; advertised in
 *   the tool description so the LLM doesn't ask for reproducibility from a
 *   non-deterministic model. Handler silently drops `seed` for models that
 *   don't honor it (lower stakes than a bad ratio — the image still renders).
 * `imageInput` — declares whether the model accepts a reference image (image-
 *   to-image / kontext-style editing). `"required"` means the model only
 *   works with a reference (e.g. `fal/flux-kontext`); the handler returns a
 *   text error if the LLM picks the model without supplying `referenceImage`.
 *   `"optional"` means the model accepts an image but doesn't require one.
 *   Absent → the model is text-only; passing `referenceImage` is rejected.
 *   Today only honored by `kind: "fal"` providers (via the AI SDK's
 *   `prompt: { text, images }` shape); openai-compatible providers reject
 *   image input at the handler boundary until a validated path lands.
 * `negativePrompt` — declares whether the model accepts a free-form
 *   negative prompt ("don't draw X"). True opts in to the per-call
 *   `negativePrompt` field in the tool input; absent or false → the field
 *   is dropped before the provider call, preventing accidental forwarding
 *   to providers that strict-reject the parameter. Today honored by fal
 *   (via `providerOptions.fal.negative_prompt`) and venice (native body
 *   field); openai-compatible models typically don't accept it.
 *
 * Forward-extensible: add `maxPromptLength`, `outputMediaType`, etc.
 * without a migration as new providers land.
 */
/**
 * Canonical aspect-ratio vocabulary. Shared between the schema (for the
 * stored JSONB shape) and the wizard / CLI input parsers (for operator-typed
 * validation) so adding a new ratio is a single-source change.
 */
export const IMAGE_ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
  "9:21",
] as const;
export type ImageAspectRatio = (typeof IMAGE_ALLOWED_ASPECT_RATIOS)[number];

export const ImageModelCapabilitiesSchema = z.object({
  aspectRatios: z.array(z.enum(IMAGE_ALLOWED_ASPECT_RATIOS)).optional(),
  seed: z.boolean().optional(),
  imageInput: z.enum(["required", "optional"]).optional(),
  negativePrompt: z.boolean().optional(),
});
export type ImageModelCapabilities = z.infer<typeof ImageModelCapabilitiesSchema>;

/**
 * Provider rows for image generation. `type` discriminates the adapter:
 * `fal` uses `@ai-sdk/fal` (no base URL), `openai_compatible` uses
 * `@ai-sdk/openai-compatible` against `${base_url}/images/generations`.
 *
 * The CHECK constraint pins the base_url invariant at the DB layer
 * (`fal ↔ NULL`, `openai_compatible ↔ NOT NULL`). The store layer adds URL
 * hygiene (https, no trailing slash) on top, returning
 * `invalid_provider_config`.
 *
 * No fallback chain — unlike `llm_providers` + `model_providers`, image
 * generation has no transparent cross-provider retry. A failed image gen
 * surfaces directly to the LLM via the tool result.
 *
 * **Extending `image_provider_type`:** the CHECK below is written as
 * per-value implications, not a closed disjunction. A new enum value (say
 * `replicate`) is unconstrained by default — it can land with or without
 * `base_url`. If the new type needs its own base_url rule, add another
 * implication clause in the same migration that adds the enum value.
 * The closed-disjunction form (`(type = 'fal' AND ...) OR (type = 'oai' AND ...)`)
 * rejects every row of a newly-added type until the constraint is
 * rewritten — surprising failure mode we deliberately avoid.
 */
export const imageProviders = pgTable(
  "image_providers",
  {
    id: pk(),
    name: text("name").notNull().unique(),
    type: imageProviderType("type").notNull(),
    baseUrl: text("base_url"), // NULL for fal, NOT NULL for openai_compatible / venice (CHECK enforced)
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id),
    attrs: jsonbZod("attrs", ImageProviderAttrsSchema).notNull(),
    createdAt: ts(),
  },
  (t) => [
    check(
      "chk_image_providers_base_url",
      // Per-value implications: each clause means "if type = X then base_url
      // satisfies Y." A type not mentioned here passes both clauses by
      // vacuous truth — see the docstring for why this matters when
      // extending the enum.
      sql`(${t.type} <> 'openai_compatible' OR ${t.baseUrl} IS NOT NULL)
        AND (${t.type} <> 'venice' OR ${t.baseUrl} IS NOT NULL)
        AND (${t.type} <> 'fal' OR ${t.baseUrl} IS NULL)`,
    ),
  ],
);

/**
 * Catalog of image models the LLM can pick from. `name` is the LLM-facing
 * key (globally unique, round-trips via the tool's `model` arg) — convention
 * is `<provider-name>/<slug>` e.g. `fal/flux-dev`, `venice/flux-dev`.
 * `model_string` is the API-facing identifier passed to
 * `provider.image(...)` / `provider.imageModel(...)`. `description` is read
 * by the LLM at every turn — write a one-line "use when..." hint, same
 * voice as the legacy `MODEL_CATALOG` blurbs. `capabilities` declares the
 * per-model knobs (see schema). `user_selectable` is the catalog-visibility
 * gate: false keeps the row in `image_models` but omits it from the
 * `generate_image` tool's `model` enum and per-model description block.
 * Image gen has no end-user model picker (unlike `model_providers.user_selectable`
 * which gates `/model`), so the only consumer this hides the row from is
 * the LLM itself. Use for deprecation and experimental models the operator
 * wants to stage without exposing.
 */
export const imageModels = pgTable("image_models", {
  id: pk(),
  providerId: uuid("provider_id")
    .notNull()
    .references(() => imageProviders.id, { onDelete: "cascade" }),
  name: text("name").notNull().unique(),
  modelString: text("model_string").notNull(),
  description: text("description").notNull(),
  capabilities: jsonbZod("capabilities", ImageModelCapabilitiesSchema).notNull(),
  userSelectable: boolean("user_selectable").notNull(),
  createdAt: ts(),
});
