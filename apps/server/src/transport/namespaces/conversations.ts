import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { CompactConversationResult } from "../../agent/conversation/compact-conversation.js";
import { toChatHistory } from "../../agent/conversation/to-chat-history.js";
import { admitsFirstParty } from "../../agent/core-memory/scope.js";
import type { AutoRecallMode } from "../../agent/recall-gate.js";
import type {
  ChatHistoryMessage,
  ConversationSummary,
  VoiceMode,
} from "../../agent/store/index.js";
import type { CooldownState, ProfileMemoryScope } from "../../agent/store/schema.js";
import { AllProvidersFailedError, extractStatus } from "../../llm/fallback.js";
import { computeBudget, resolveLimits } from "../../llm/models.js";
import { ProviderConfigError } from "../../llm/resolver.js";
import { logger } from "../../logger.js";
import type { McpRegistry } from "../../mcp/registry.js";
import type { TransportError } from "../transport-error.js";
import { resolveOwnedConversation, type TransportContext } from "./context.js";
import { emitCooldownClearedIfAny } from "./cooldown-cleared.js";

export interface CurrentConversation {
  conversationId: string;
  profileId: string;
  profileName: string;
  model: string;
  /** Per-conversation voice mode override; null = follow profile default. */
  voiceMode: VoiceMode | null;
  /** Profile-level voice mode default — used as the fallback when override is null. */
  profileVoiceMode: VoiceMode;
}

/**
 * Snapshot of a conversation's state surfaced to channel adapters for
 * `/status`. Aggregates conversation lifecycle stats, the active profile,
 * the last LLM turn's persisted token counts (no live recount — see the
 * design note on /status), steering rule visibility, and the MCP fan-out
 * — all in a single Transport call so the renderer doesn't fan out itself.
 *
 * `lastTurn` is `null` until the first assistant row exists. `mcp` is `null`
 * when the deployment has no MCP registry wired (`mcp_disabled` in other
 * surfaces). `contextBudget` is `null` when the model is unknown to both
 * the DB override and the bundled LiteLLM snapshot — the resolver still
 * returns a conservative default for the agent loop, but `/status` would
 * mislead by displaying that guess as fact, so we elide it instead.
 */
export interface ConversationStatusSummary {
  conversationId: string;
  alias: string | undefined;
  /**
   * Auto-repair cooldown blob; null = normal operation. When set, the
   * `/status` renderer surfaces "cooling down" with a time-remaining
   * estimate. See `design/agent-resilience.md` → Auto-repair.
   */
  cooldownState: CooldownState | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  messageCount: number;
  profile: {
    id: string;
    name: string;
    model: string;
    toolCount: number;
    autoRecall: AutoRecallMode;
    memoryScope: ProfileMemoryScope | null;
    /**
     * Speaker-isolation class (`profile.profile_class`). Surfaced here so
     * `formatScope` can render the effective recall filter — the Service
     * auto-includes the speaker's class in the explicit class leaf, and
     * the rendered scope should reflect that to avoid operator surprise.
     */
    profileClass: string | null;
    voiceMode: VoiceMode;
  };
  /** Per-conversation override; null = follow profile default. */
  voiceMode: VoiceMode | null;
  lastTurn: { inputTokens: number | null; outputTokens: number } | null;
  contextBudget: number | null;
  steeringRulesCount: number;
  mcp: {
    enabledServers: number;
    approvedTools: number;
    toolBudget: number;
  } | null;
}

/**
 * What `/compact` did. `no_session` mirrors `getCurrent`'s "you have nothing
 * here" affordance rather than surfacing an error code.
 */
export type CompactConversationOutcome =
  | { status: "no_session" }
  | { status: "skipped"; reason: "too_short" | "nothing_new" | "empty_summary" | "truncated" }
  | { status: "compacted"; messagesSummarized: number; messagesKept: number; model: string };

/** Conversation admin. `platformUserHandle` is resolved to a userId for ACL. */
export interface ConversationsNamespace {
  list(
    platformUserHandle: string,
  ): Promise<Result<ReadonlyArray<ConversationSummary>, TransportError>>;
  /**
   * Ordered message history of a conversation the caller owns — the web chat
   * history read. Each turn is flattened to displayable `text`. Identity- and
   * ownership-checked: `access_denied` when the conversation isn't the caller's.
   */
  getMessages(
    platformUserHandle: string,
    conversationId: string,
  ): Promise<Result<ReadonlyArray<ChatHistoryMessage>, TransportError>>;
  /** Current session's conversation + profile, or null if no active session exists for the address. */
  getCurrent(
    platformUserHandle: string,
    platformAddress: string,
  ): Promise<Result<CurrentConversation | null, TransportError>>;
  /**
   * Aggregate state for the current session's conversation — used by
   * `/status`. Returns `ok(null)` when no active session exists for the
   * address (same shape as `getCurrent`). Identity-checked against
   * `user_identities`; ownership mismatch resolves to `ok(null)` rather
   * than `access_denied` to mirror `getCurrent`'s "you have no current
   * conversation" affordance. Reads persisted token counts only — no
   * live LLM `countTokens` call.
   */
  summary(
    platformUserHandle: string,
    platformAddress: string,
  ): Promise<Result<ConversationStatusSummary | null, TransportError>>;
  setAlias(
    platformUserHandle: string,
    conversationId: string,
    alias: string | null,
  ): Promise<Result<void, TransportError>>;
  setProfile(
    platformUserHandle: string,
    conversationId: string,
    profileId: string,
  ): Promise<Result<void, TransportError>>;
  /**
   * Clear the auto-repair `cooldown_state` blob, ending any active
   * cooldown so the next inbound runs `handle-message` normally. Used
   * by the `/repair` control command — the user-facing escape hatch
   * over the `recover-conversation` automated path. Idempotent: a
   * `/repair` on an already-clear conversation returns
   * `wasCoolingDown: false` and succeeds without writing.
   *
   * Identity + ownership checked like `setAlias` / `setProfile` —
   * `identity_rejected` for non-resolved handles, `conversation_not_found`
   * when the row doesn't exist, `access_denied` when the caller doesn't
   * own the conversation.
   */
  repair(
    platformUserHandle: string,
    conversationId: string,
  ): Promise<Result<{ wasCoolingDown: boolean }, TransportError>>;
  /**
   * Summarize the current session's conversation now and store the result,
   * so the next turn replays the summary instead of paying for it under
   * budget pressure. Backs the `/compact` control command.
   *
   * Runs the summarization LLM call inline — the caller is waiting on the
   * reply. Identity-checked; returns `ok({status: "no_session"})` when the
   * address has no active conversation, and `compaction_unavailable` on a
   * deployment that didn't wire the driver.
   */
  compact(
    platformUserHandle: string,
    platformAddress: string,
  ): Promise<Result<CompactConversationOutcome, TransportError>>;
  /**
   * Set or clear the per-conversation voice mode override. `null` clears
   * the override (the conversation falls back to the profile default).
   * Identity + ownership checked like `setAlias` / `setProfile`. Adapters
   * call this in response to user `/voice` commands. See design/voice.md.
   */
  setVoiceMode(
    platformUserHandle: string,
    conversationId: string,
    mode: VoiceMode | null,
  ): Promise<Result<void, TransportError>>;
}

export function createConversations(
  deps: TransportContext & {
    inngest: Inngest;
    mcpRegistry: McpRegistry | undefined;
    compactConversation:
      | ((conversationId: string) => Promise<CompactConversationResult>)
      | undefined;
  },
): ConversationsNamespace {
  const {
    channelId,
    runInTx,
    transportStore,
    agentStore,
    inngest,
    mcpRegistry,
    compactConversation,
  } = deps;
  return {
    async list(platformUserHandle) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        return ok(await agentStore.listConversationsForUser(tx, identity.userId));
      });
    },

    async getMessages(platformUserHandle, conversationId) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const conv = await agentStore.getConversation(tx, conversationId);
        if (!conv) return err({ code: "conversation_not_found" as const });
        if (conv.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "conversation not owned by caller",
          });
        }
        return ok(toChatHistory(await agentStore.listMessages(tx, conversationId)));
      });
    },

    async getCurrent(platformUserHandle, platformAddress) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const session = await transportStore.resolveSession(tx, channelId, platformAddress);
        if (!session) return ok(null);
        const conv = await agentStore.getConversation(tx, session.conversationId);
        if (!conv || conv.userId !== identity.userId) return ok(null);
        const profile = await agentStore.getProfile(tx, conv.profileId);
        if (!profile) return err({ code: "profile_not_found" as const });
        return ok({
          conversationId: conv.id,
          profileId: conv.profileId,
          profileName: profile.name,
          model: profile.model,
          voiceMode: conv.voiceMode,
          profileVoiceMode: profile.voiceMode,
        });
      });
    },

    async summary(
      platformUserHandle,
      platformAddress,
    ): Promise<Result<ConversationStatusSummary | null, TransportError>> {
      return runInTx(
        async (tx): Promise<Result<ConversationStatusSummary | null, TransportError>> => {
          const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
          if (!identity) return err({ code: "identity_rejected" as const });
          const session = await transportStore.resolveSession(tx, channelId, platformAddress);
          if (!session) return ok(null);
          const conv = await agentStore.getConversation(tx, session.conversationId);
          if (!conv || conv.userId !== identity.userId) return ok(null);
          const profile = await agentStore.getProfile(tx, conv.profileId);
          if (!profile) return err({ code: "profile_not_found" as const });

          // Independent reads — fan out so /status doesn't pay six round-trips
          // sequentially. Each query is cheap on its own; the user is waiting
          // on the slowest one.
          const [stats, alias, lastTurn, rules, mcpServers] = await Promise.all([
            agentStore.getConversationStats(tx, conv.id),
            agentStore.getAliasForConversation(tx, identity.userId, conv.id),
            agentStore.getLastTokens(tx, conv.id),
            // The rules `# Rules` renders for this conversation.
            agentStore.getActiveRules(tx, {
              profileId: conv.profileId,
              userId: admitsFirstParty(profile) ? identity.userId : null,
            }),
            mcpRegistry ? mcpRegistry.listServers() : Promise.resolve(null),
          ]);
          if (!stats) return err({ code: "conversation_not_found" as const });

          // Resolve effective limits without a row override — `/status` is
          // a read-only display, not a routing decision, so we don't pay
          // for the per-turn DB read here. resolveLimits never throws:
          // unknown models fall back to the conservative default. We
          // surface `null` whenever any column came from the default —
          // sessions-ux renders the budget conditionally on this null,
          // and a default-sourced contextWindow would be a guess we'd
          // rather not display as fact.
          const resolved = resolveLimits(profile.model);
          const isGuess =
            resolved.contextWindowSource === "default" ||
            resolved.maxOutputTokensSource === "default";
          const contextBudget = isGuess ? null : computeBudget(resolved);

          const mcp =
            mcpServers === null
              ? null
              : {
                  enabledServers: mcpServers.filter((s) => s.enabled).length,
                  approvedTools: mcpServers
                    .filter((s) => s.enabled && s.approvalStatus === "approved")
                    .reduce((sum, s) => sum + s.approvedToolCount, 0),
                  toolBudget: mcpRegistry?.toolBudget() ?? 0,
                };

          return ok({
            conversationId: conv.id,
            alias,
            cooldownState: conv.cooldownState,
            createdAt: stats.createdAt,
            lastMessageAt: stats.lastMessageAt,
            messageCount: stats.messageCount,
            profile: {
              id: profile.id,
              name: profile.name,
              model: profile.model,
              toolCount: profile.toolSet.length,
              autoRecall: profile.autoRecall,
              memoryScope: profile.memoryScope,
              profileClass: profile.profileClass,
              voiceMode: profile.voiceMode,
            },
            voiceMode: conv.voiceMode,
            // `getLastTokens` returns `undefined` when no assistant rows exist;
            // normalize to null so the renderer only branches on one shape.
            lastTurn: lastTurn ?? null,
            contextBudget,
            steeringRulesCount: rules.length,
            mcp,
          });
        },
      );
    },

    async setAlias(platformUserHandle, conversationId, alias) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const conv = await agentStore.getConversation(tx, conversationId);
        if (!conv) return err({ code: "conversation_not_found" as const });
        if (conv.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "conversation not owned by caller",
          });
        }
        if (!conv.isPrivate) {
          return err({
            code: "access_denied" as const,
            reason: "aliases are not allowed on non-private conversations",
          });
        }
        const set = await agentStore.setAlias(tx, identity.userId, conversationId, alias);
        if (set.isErr()) return err({ code: "alias_taken" as const });
        return ok(undefined);
      });
    },

    async setProfile(platformUserHandle, conversationId, profileId) {
      const txResult = await runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const conv = await agentStore.getConversation(tx, conversationId);
        if (!conv) return err({ code: "conversation_not_found" as const });
        if (conv.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "conversation not owned by caller",
          });
        }
        // Profile must be visible to the caller (org OR their own).
        const owner = await agentStore.getProfileOwner(tx, profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId !== null && owner.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "profile not visible to caller",
          });
        }
        await agentStore.setConversationProfile(tx, conversationId, profileId);
        // Auto-repair clear trigger — `/profile` is a context switch
        // ("the new profile has its own provider/tools and may not
        // exhibit the failure"), so end any active cooldown in the
        // same tx. Atomicity matters: a partial commit could leave
        // the conversation switched but still cooling down. Skip
        // the write when `cooldown_state` is already NULL —
        // Postgres MVCC writes a fresh tuple version on every
        // UPDATE regardless of whether values changed (no
        // suppress_redundant_updates_trigger on this table), so
        // the gate avoids a wasted row version + WAL entry per
        // profile switch. See design/agent-resilience.md → Clear
        // triggers.
        if (conv.cooldownState !== null) {
          await agentStore.clearCooldown(tx, conversationId);
        }
        // Return the prior cooldown_state so the telemetry emit
        // outside the tx can compute elapsed time and decide whether
        // to fire at all. Emitting inside the tx would risk a
        // phantom event on rollback.
        return ok({ priorCooldownState: conv.cooldownState });
      });
      if (txResult.isErr()) return err(txResult.error);
      await emitCooldownClearedIfAny(
        inngest,
        txResult.value.priorCooldownState,
        conversationId,
        "profile_switch",
      );
      return ok(undefined);
    },

    async repair(platformUserHandle, conversationId) {
      const txResult = await runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const conv = await agentStore.getConversation(tx, conversationId);
        if (!conv) return err({ code: "conversation_not_found" as const });
        if (conv.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "conversation not owned by caller",
          });
        }
        const wasCoolingDown = conv.cooldownState !== null;
        if (wasCoolingDown) {
          await agentStore.clearCooldown(tx, conversationId);
        }
        return ok({ wasCoolingDown, priorCooldownState: conv.cooldownState });
      });
      if (txResult.isErr()) return err(txResult.error);
      await emitCooldownClearedIfAny(
        inngest,
        txResult.value.priorCooldownState,
        conversationId,
        "user_repair",
      );
      return ok({ wasCoolingDown: txResult.value.wasCoolingDown });
    },

    async compact(platformUserHandle, platformAddress) {
      if (!compactConversation) {
        return err({ code: "compaction_unavailable" as const });
      }
      const resolved = await resolveOwnedConversation(deps, platformUserHandle, platformAddress);
      if (resolved.kind === "identity_rejected") {
        return err({ code: "identity_rejected" as const });
      }
      if (resolved.kind === "no_session") {
        return ok({ status: "no_session" as const });
      }
      // Broad by design: everything the driver can throw — provider
      // resolution, the summarization call, the store write — is a failure
      // this one code is the designed channel for. Without it the rejected
      // promise escapes a `Result`-returning method and the adapter's
      // `isErr()` branch never runs.
      let result: CompactConversationResult;
      try {
        result = await compactConversation(resolved.conversationId);
      } catch (error) {
        logger.error({ err: error, conversationId: resolved.conversationId }, "compaction failed");
        return err({
          code: "compaction_failed" as const,
          reason: compactionFailureReason(error),
        });
      }
      if (result.status === "not_found") {
        // A vanished conversation is the mid-call disappearance `/reflect`
        // reports as a skip, rendered as "nothing here" for the same reason.
        // A vanished profile is different: `resolveOwnedConversation` just
        // succeeded on this conversation, so telling the user to send a
        // message would be advice that cannot work.
        return result.missing === "conversation"
          ? ok({ status: "no_session" as const })
          : err({ code: "profile_not_found" as const });
      }
      return ok(result);
    },

    async setVoiceMode(platformUserHandle, conversationId, mode) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const conv = await agentStore.getConversation(tx, conversationId);
        if (!conv) return err({ code: "conversation_not_found" as const });
        if (conv.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "conversation not owned by caller",
          });
        }
        await agentStore.setConversationVoiceMode(tx, conversationId, mode);
        return ok(undefined);
      });
    },
  };
}

/**
 * What of a compaction failure is safe to put in front of the user.
 *
 * A misconfigured summarization model names a model or a provider row plus
 * an instruction to re-run `cogmo setup` — operator-chosen identifiers, never
 * credentials. An HTTP failure contributes only its status: 429 and 5xx are
 * the likeliest way `/compact` fails and the only detail that tells the user
 * whether waiting helps, while the response body is not ours to relay. That
 * status is read out of `AllProvidersFailedError` when the chain wrapped it,
 * which is the shape every retriable failure arrives in. The
 * wording stops at the status because `extractStatus` sees everything the
 * driver can throw — stores, prompt assembly, the secrets decrypt — and
 * naming the summarization model would be an attribution this cannot make.
 * Everything else is withheld — a Drizzle failure stringifies as its whole
 * INSERT plus bound params, which for this table is the summary text itself.
 */
function compactionFailureReason(error: unknown): string | null {
  if (error instanceof ProviderConfigError) return error.message;
  // Every chain is wrapped in `FallbackLlmProvider`, which converts a final
  // *retriable* failure into `AllProvidersFailedError` and lets permanent
  // ones through bare. So the statuses actually worth telling the user about
  // — 429 and 5xx, the ones where waiting helps — arrive inside the
  // aggregate, and reading only the top-level error would surface a status
  // for exactly the failures where waiting does not help.
  const candidates =
    error instanceof AllProvidersFailedError ? error.attempts.map((a) => a.error) : [error];
  // Newest first, and skip the ones carrying no status: a chain can end on a
  // DNS or TLS failure after an earlier candidate returned the 429 that is
  // the reason to surface a status at all.
  const status = candidates
    .toReversed()
    .filter((c) => c instanceof Error)
    .map(extractStatus)
    .find((s) => s !== undefined);
  return status === undefined ? null : `the request failed with HTTP ${status}`;
}
