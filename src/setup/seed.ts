import type { AgentStore } from "../agent/store/index.js";
import { logger } from "../logger.js";
import type { TransportStore } from "../transport/store/index.js";

export const DEFAULT_BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

const DEFAULT_TOOL_SET = ["get_current_time", "memory_recall", "memory_retain"];

/** Create the default user if none exists. Returns the user ID. */
export async function ensureDefaultUser(agentStore: AgentStore): Promise<string> {
  const existing = await agentStore.getFirstUser();
  if (existing) return existing.id;
  const { id } = await agentStore.createUser();
  logger.info({ userId: id }, "created default user");
  return id;
}

/** Create the default profile if none exists. Returns the profile ID. */
export async function ensureDefaultProfile(agentStore: AgentStore): Promise<string> {
  const existing = await agentStore.getDefaultProfile();
  if (existing) return existing.id;
  const { id } = await agentStore.createProfile({
    name: "assistant",
    basePrompt: DEFAULT_BASE_PROMPT,
    model: "claude-sonnet-4-20250514",
    toolSet: DEFAULT_TOOL_SET,
  });
  logger.info({ profileId: id }, "created default profile");
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
