### `generate_image` — catalog adds Recraft, Ideogram Character, Imagen 4, Qwen Image

The `generate_image` tool's curated `MODEL_CATALOG` was Flux-only. Four non-Flux additions cover gaps the Flux family doesn't reach:

- `fal-ai/recraft/v3/text-to-image` — readable text in images, logos, vector/illustration styles, brand-color control. The clear gap in the prior lineup; Flux struggles with rendered text.
- `fal-ai/ideogram/character` — character consistency across multiple generations, also strong at typography.
- `fal-ai/qwen-image` — autoregressive (not diffusion), complex text rendering and detailed prompt adherence.
- `fal-ai/imagen4/preview` — Google Imagen 4, photorealism with accurate typography.

Default stays `fal-ai/flux/dev`. The tool description gains a one-line "use when…" entry per model so the LLM can pick by task. Selection is per-call via the `model` enum — no profile or DB changes; no provider work since `@ai-sdk/fal` already accepts these IDs in its `FalImageModelId` type.
