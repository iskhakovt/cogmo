import type { AgentStore } from "../agent/store/index.js";
import type { ImageModelCapabilities } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { TransportStore } from "../transport/store/index.js";

export const DEFAULT_BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

/**
 * Default org profile sees every registered tool. `toolSet` is interpreted as
 * a list of picomatch globs against the merged tool registry (built-ins +
 * skills + MCP); `["*"]` matches every tool name. Empty array = chat-only.
 *
 * Operators who want a curated tool set per profile use `/profile new` /
 * `/profile edit` to set explicit names or per-server globs (e.g.
 * `["memory_*", "mcp__github__*"]`).
 */
const DEFAULT_TOOL_SET = ["*"];

/** Create the default user if none exists. Returns the user ID. */
export async function ensureDefaultUser(
  runInTx: Transactor,
  agentStore: AgentStore,
): Promise<string> {
  return runInTx(async (tx) => {
    const existing = await agentStore.getFirstUser(tx);
    if (existing) return existing.id;
    const { id } = await agentStore.createUser(tx);
    logger.info({ userId: id }, "created default user");
    return id;
  });
}

/** Create the default org profile if none exists. Returns the profile ID. Org profiles have `userId: null` — visible to all users, read-only via Transport. */
export async function ensureDefaultProfile(
  runInTx: Transactor,
  agentStore: AgentStore,
): Promise<string> {
  return runInTx(async (tx) => {
    const existing = await agentStore.getDefaultProfile(tx);
    if (existing) return existing.id;
    const { id } = await agentStore.createProfile(tx, {
      userId: null,
      name: "assistant",
      basePrompt: DEFAULT_BASE_PROMPT,
      model: "claude-sonnet-5",
      toolSet: DEFAULT_TOOL_SET,
    });
    logger.info({ profileId: id }, "created default org profile");
    return id;
  });
}

/**
 * Create a single-owner `fixed`-identity channel of `type` + its wildcard
 * identity if none exists. Both the direct (CLI) and web channels are
 * single-owner with the same fixed/wildcard wiring; a future single-owner
 * channel type reuses this directly.
 */
async function ensureFixedChannel(
  runInTx: Transactor,
  transportStore: TransportStore,
  userId: string,
  type: "direct" | "web",
): Promise<void> {
  await runInTx(async (tx) => {
    const existing = await transportStore.getChannelByType(tx, type);
    if (existing) return;
    const { id: channelId } = await transportStore.createChannel(tx, {
      type,
      credentials: {},
      identityMode: "fixed",
    });
    await transportStore.createWildcardIdentity(tx, { userId, channelId });
    logger.info({ channelId, type }, "created fixed-identity channel");
  });
}

/** Create the direct channel + wildcard identity if none exists. */
export function ensureDirectChannel(
  runInTx: Transactor,
  transportStore: TransportStore,
  userId: string,
): Promise<void> {
  return ensureFixedChannel(runInTx, transportStore, userId, "direct");
}

/** Create the web channel + wildcard identity if none exists. */
export function ensureWebChannel(
  runInTx: Transactor,
  transportStore: TransportStore,
  userId: string,
): Promise<void> {
  return ensureFixedChannel(runInTx, transportStore, userId, "web");
}

const TELEGRAM_DEFAULT_RULES = [
  "Avoid tables — they don't render on this channel. Use bullet lists instead.",
  "Prefer concise replies. For longer answers, use headings and short paragraphs.",
  "Keep bullet lists to one level of nesting.",
];

/** Seed default channel-scoped steering rules. Idempotent — skips if channel-specific rules already exist. */
export async function seedChannelRules(
  runInTx: Transactor,
  agentStore: AgentStore,
  channelType: string,
): Promise<void> {
  await runInTx(async (tx) => {
    if (await agentStore.hasChannelRules(tx, channelType)) return;

    const rules = channelType === "telegram" ? TELEGRAM_DEFAULT_RULES : [];

    for (const rule of rules) {
      await agentStore.insertManualRule(tx, {
        rule,
        category: "style",
        channelType,
        priority: 50,
      });
    }

    if (rules.length > 0) {
      logger.info({ channelType, count: rules.length }, "seeded channel steering rules");
    }
  });
}

/** Run all seed steps. Idempotent. */
export async function seedDefaults(
  runInTx: Transactor,
  agentStore: AgentStore,
  transportStore: TransportStore,
): Promise<{ userId: string; profileId: string }> {
  const userId = await ensureDefaultUser(runInTx, agentStore);
  const profileId = await ensureDefaultProfile(runInTx, agentStore);
  await ensureDirectChannel(runInTx, transportStore, userId);
  await ensureWebChannel(runInTx, transportStore, userId);
  return { userId, profileId };
}

// --- Image gen seed (fal defaults) ---

const FAL_DEFAULT_RATIOS: NonNullable<ImageModelCapabilities["aspectRatios"]> = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
];

interface FalDefaultModel {
  name: string;
  modelString: string;
  description: string;
  capabilities: ImageModelCapabilities;
}

/**
 * Canonical curated fal model catalog seeded by `ensureFalImageDefaults`.
 * Mirrors the legacy hardcoded `MODEL_CATALOG` from `src/agent/image-tools.ts`,
 * plus per-model capability metadata that the LLM reads at every turn.
 *
 * Re-seeding via `ON CONFLICT (name) DO NOTHING` preserves operator edits.
 * Adding a new entry takes effect the next time `ensureFalImageDefaults`
 * runs (boot or `pnpm seed-images`); changing an existing entry's
 * description / capabilities here will NOT overwrite a row the operator
 * has already touched.
 */
const FAL_DEFAULT_MODELS: ReadonlyArray<FalDefaultModel> = [
  {
    name: "fal/flux-schnell",
    modelString: "fal-ai/flux/schnell",
    description: "fastest, cheapest, good for quick iteration or drafts",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS], seed: true },
  },
  {
    name: "fal/flux-dev",
    modelString: "fal-ai/flux/dev",
    description: "balanced speed/quality, good default for general use",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS], seed: true },
  },
  {
    name: "fal/flux-pro-v1.1",
    modelString: "fal-ai/flux-pro/v1.1",
    description: "higher quality, detailed scenes and portraits",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS], seed: true },
  },
  {
    name: "fal/flux-pro-ultra",
    modelString: "fal-ai/flux-pro/v1.1-ultra",
    description: "highest quality, longer wait, slower iteration",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS], seed: true },
  },
  {
    name: "fal/imagen4",
    modelString: "fal-ai/imagen4/preview",
    description: "Google Imagen 4 — photorealism, accurate typography, strong prompt adherence",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS] },
  },
  {
    name: "fal/recraft-v3",
    modelString: "fal-ai/recraft/v3/text-to-image",
    description: "best for readable text, logos, vector/illustration, brand assets",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS] },
  },
  {
    name: "fal/ideogram-character",
    modelString: "fal-ai/ideogram/character",
    description: "consistent character across multiple images; strong typography",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS] },
  },
  {
    name: "fal/qwen-image",
    modelString: "fal-ai/qwen-image",
    description: "autoregressive — strong complex text rendering and prompt adherence",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS], seed: true },
  },
  {
    name: "fal/flux-kontext",
    modelString: "fal-ai/flux-pro/kontext",
    description:
      "image editing — modify an existing image (resize, restyle, swap subjects). " +
      "Always pass a `referenceImage` path to the image you're editing.",
    capabilities: { aspectRatios: [...FAL_DEFAULT_RATIOS], seed: true, imageInput: "required" },
  },
];

/**
 * Seed the canonical `fal` image-gen provider and its default model catalog.
 *
 * Behaviour:
 * - If a `fal_api_key` secret already exists, use it.
 * - Else if `envFalApiKey` is set (the legacy `FAL_API_KEY` env var path),
 *   materialize it into a `fal_api_key` secret — dev-convenience continuity
 *   so single-machine setups don't need to run the wizard before seeing
 *   image gen come online.
 * - Else return `{ skipped: true }` — nothing to seed.
 *
 * Once a secret exists, ensure an `image_providers` row named `fal` exists
 * (link to the secret), and upsert the canonical model catalog by `name`.
 * Idempotent: re-running preserves operator edits to existing rows.
 */
export async function ensureFalImageDefaults(deps: {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
  envFalApiKey?: string;
}): Promise<
  | { skipped: true; reason: "no_fal_secret" }
  | { seeded: true; providerCreated: boolean; modelsInserted: number }
> {
  return deps.runInTx(async (tx) => {
    let secretMeta = await deps.secretsStore.getSecretMeta(tx, "fal_api_key");
    if (!secretMeta && deps.envFalApiKey) {
      const { id } = await deps.secretsStore.putSecret(tx, {
        name: "fal_api_key",
        plaintext: deps.envFalApiKey,
        description: "fal.ai API key (materialized from FAL_API_KEY env var)",
      });
      secretMeta = { id, name: "fal_api_key", description: null, validatedAt: null };
      logger.info({ secretId: id }, "materialized fal_api_key from FAL_API_KEY env var");
    }
    if (!secretMeta) return { skipped: true, reason: "no_fal_secret" };

    const existing = await deps.agentStore.findImageProviderByName(tx, "fal");
    const providerId = existing
      ? existing.id
      : (
          await deps.agentStore.createImageProvider(tx, {
            name: "fal",
            type: "fal",
            baseUrl: null,
            secretId: secretMeta.id,
            attrs: {},
          })
        ).id;

    const inserted = await deps.agentStore.upsertImageModelsByName(
      tx,
      FAL_DEFAULT_MODELS.map((m) => ({
        providerId,
        name: m.name,
        modelString: m.modelString,
        description: m.description,
        capabilities: m.capabilities,
        userSelectable: true,
      })),
    );
    logger.info(
      { providerId, providerCreated: !existing, modelsInserted: inserted },
      "seeded fal image defaults",
    );
    return { seeded: true, providerCreated: !existing, modelsInserted: inserted };
  });
}
