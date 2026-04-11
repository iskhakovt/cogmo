import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { DrizzleAgentStore } from "./agent/store/index.js";
import * as schema from "./db/schemas.js";
import { logger } from "./logger.js";
import { DrizzleTransportStore } from "./transport/store/index.js";

const DEFAULT_BASE_PROMPT = `You are a personal AI assistant. You are helpful, concise, and direct.

You have access to tools — use them when they help answer the user's question.
If you don't know something and don't have a tool for it, say so honestly.`;

/**
 * Seed the database with default data for single-user deployment.
 *
 * Idempotent — safe to run multiple times.
 * Creates: user, profile, direct channel, wildcard identity.
 *
 * Only requires DATABASE_URL — no other env vars needed.
 */
export async function seed(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://cogmo@localhost/cogmo";
  const db = drizzle({ connection: databaseUrl, schema });

  await migrate(db, { migrationsFolder: "./migrations" });
  logger.info("migrations applied");

  const agentStore = new DrizzleAgentStore(db);
  const transportStore = new DrizzleTransportStore(db);

  // User
  const existingUser = await agentStore.getFirstUser();
  const userId = existingUser?.id ?? (await agentStore.createUser()).id;

  // Profile
  const existingProfile = await agentStore.getDefaultProfile();
  const profileId =
    existingProfile?.id ??
    (
      await agentStore.createProfile({
        name: "assistant",
        basePrompt: DEFAULT_BASE_PROMPT,
        model: "claude-sonnet-4-20250514",
        toolSet: ["get_current_time", "memory_recall", "memory_retain"],
      })
    ).id;

  // Direct channel + wildcard identity
  const existingChannel = await transportStore.getChannelByType("direct");
  if (!existingChannel) {
    const { id: channelId } = await transportStore.createChannel({
      type: "direct",
      credentials: {},
      identityMode: "fixed",
    });
    await transportStore.createWildcardIdentity({ userId, channelId });
  }

  logger.info({ userId, profileId }, "seed complete");
  await db.$client.end();
}
