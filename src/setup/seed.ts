import type { AgentStore } from "../agent/store/index.js";
import { logger } from "../logger.js";
import type { TransportStore } from "../transport/store/index.js";

export const DEFAULT_BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

const DEFAULT_TOOL_SET = [
  "get_current_time",
  "memory_recall",
  "memory_retain",
  "memory_reflect",
  "generate_image",
];

/** Create the default user if none exists. Returns the user ID. */
export async function ensureDefaultUser(agentStore: AgentStore): Promise<string> {
  const existing = await agentStore.getFirstUser();
  if (existing) return existing.id;
  const { id } = await agentStore.createUser();
  logger.info({ userId: id }, "created default user");
  return id;
}

/** Create the default org profile if none exists. Returns the profile ID. Org profiles have `userId: null` — visible to all users, read-only via Transport. */
export async function ensureDefaultProfile(agentStore: AgentStore): Promise<string> {
  const existing = await agentStore.getDefaultProfile();
  if (existing) return existing.id;
  const { id } = await agentStore.createProfile({
    userId: null,
    name: "assistant",
    basePrompt: DEFAULT_BASE_PROMPT,
    model: "claude-sonnet-4-6",
    toolSet: DEFAULT_TOOL_SET,
  });
  logger.info({ profileId: id }, "created default org profile");
  return id;
}

/** Create the direct channel + wildcard identity if none exists. */
export async function ensureDirectChannel(
  transportStore: TransportStore,
  userId: string,
): Promise<void> {
  const existing = await transportStore.getChannelByType("direct");
  if (existing) return;
  const { id: channelId } = await transportStore.createChannel({
    type: "direct",
    credentials: {},
    identityMode: "fixed",
  });
  await transportStore.createWildcardIdentity({ userId, channelId });
  logger.info({ channelId }, "created direct channel");
}

const TELEGRAM_DEFAULT_RULES = [
  "Avoid tables — they don't render on this channel. Use bullet lists instead.",
  "Prefer concise replies. For longer answers, use headings and short paragraphs.",
  "Keep bullet lists to one level of nesting.",
];

/** Seed default channel-scoped steering rules. Idempotent — skips if channel-specific rules already exist. */
export async function seedChannelRules(agentStore: AgentStore, channelType: string): Promise<void> {
  if (await agentStore.hasChannelRules(channelType)) return;

  const rules = channelType === "telegram" ? TELEGRAM_DEFAULT_RULES : [];

  for (const rule of rules) {
    await agentStore.insertManualRule({
      rule,
      category: "style",
      channelType,
      priority: 50,
    });
  }

  if (rules.length > 0) {
    logger.info({ channelType, count: rules.length }, "seeded channel steering rules");
  }
}

/** Run all seed steps. Idempotent. */
export async function seedDefaults(
  agentStore: AgentStore,
  transportStore: TransportStore,
): Promise<{ userId: string; profileId: string }> {
  const userId = await ensureDefaultUser(agentStore);
  const profileId = await ensureDefaultProfile(agentStore);
  await ensureDirectChannel(transportStore, userId);
  return { userId, profileId };
}
