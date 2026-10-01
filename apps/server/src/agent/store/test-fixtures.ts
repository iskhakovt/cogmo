/**
 * Rows the agent store tests build on: a user, an org profile, and a private
 * conversation between them, written through the stores that own them.
 */

import type { Transactor } from "../../db/index.js";
import { expectOk } from "../../test/assertions.js";
import { DrizzleConversationStore } from "./conversations.js";
import { DrizzleProfileStore } from "./profiles.js";
import { DrizzleUserStore } from "./users.js";

export const TEST_MODEL = "claude-sonnet-4-6";

export async function seedUser(tx: Transactor): Promise<string> {
  return (await tx((trx) => new DrizzleUserStore().createUser(trx))).id;
}

export async function seedProfile(tx: Transactor): Promise<string> {
  return (
    await tx((trx) =>
      new DrizzleProfileStore()
        .createProfile(trx, {
          userId: null,
          name: "test",
          basePrompt: "You are a test assistant.",
          model: TEST_MODEL,
          toolSet: ["tool_a"],
        })
        .then(expectOk),
    )
  ).id;
}

export async function seedConversation(tx: Transactor): Promise<{
  userId: string;
  profileId: string;
  conversationId: string;
  /** Convenience — spread into insertMessage/insertMessages to stamp the turn. */
  stamp: { profileId: string; model: string };
}> {
  const userId = await seedUser(tx);
  const profileId = await seedProfile(tx);
  const conversationId = (
    await tx((trx) =>
      new DrizzleConversationStore().createConversation(trx, {
        userId,
        profileId,
        isPrivate: true,
      }),
    )
  ).id;
  return { userId, profileId, conversationId, stamp: { profileId, model: TEST_MODEL } };
}
