import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { JsonValue } from "type-fest";
import type { CodingStore } from "../agent/coding/store/index.js";
import { ProfileInUseError, UniqueViolationError } from "../agent/store/errors.js";
import type { AgentStore, ConversationSummary, Profile } from "../agent/store/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
import { logger } from "../logger.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { Session, TransportStore } from "./store/index.js";

export interface ProfileInput {
  name: string;
  basePrompt: string;
  model: string;
  toolSet: JsonValue;
  // summarizationModel / extractionModel are profile-level fields in the DB but not yet exposed
  // via Transport — /profile edit doesn't cover them. Add back here when the dialog does.
}

/** Summary fields exposed to channel adapters for `/repo list`. */
export interface RepoSummary {
  id: string;
  name: string;
  localPath: string;
  defaultBranch: string;
  remoteUrl: string;
  verifyCommand: string;
}

/**
 * Input for `repos.add` (slice 1 — minimal positional form). FSM dialog with
 * auto-clone + private-repo PAT injection lands in slice 4 alongside the
 * push/PR flow that needs credentials.
 */
export interface RepoInput {
  name: string;
  localPath: string;
  remoteUrl: string;
  /** Optional override; defaults to "main" when omitted. */
  defaultBranch?: string;
  /**
   * Optional override; defaults to `"true"` (no-op) so slice-1 plan-only
   * tasks have something to record. Slice 4's verify+push step needs a real
   * value and the user can update via `/repo edit` (later) or SQL meanwhile.
   */
  verifyCommand?: string;
}

export interface CurrentConversation {
  conversationId: string;
  profileId: string;
  profileName: string;
  model: string;
}

export type TransportError =
  | { code: "session_not_found"; sessionId: string }
  | { code: "identity_rejected" }
  | { code: "conversation_not_found" }
  | { code: "profile_not_found" }
  | { code: "profile_in_use" }
  | { code: "profile_name_taken" }
  | { code: "model_unavailable"; model: string }
  | { code: "alias_taken" }
  | { code: "operation_not_permitted" }
  | { code: "access_denied"; reason: string }
  | { code: "repo_not_found"; name: string }
  | { code: "repo_name_taken"; name: string }
  | { code: "repo_in_use"; name: string; activeTasks: number }
  | { code: "sandbox_disabled" };

/**
 * Transport — the adapter-facing contract for session management and inbound emission.
 *
 * Scoped to a channel (channelId baked in). Adapters call it without knowing
 * about channelId, userId resolution, or event emission mechanics.
 *
 * Returns Result<T, TransportError> — adapters handle errors gracefully.
 */
export interface Transport {
  resolveSession(platformAddress: string): Promise<Session | null>;
  createConversation(
    platformAddress: string,
    platformUserHandle: string,
    opts: { isPrivate: boolean; profileId?: string },
  ): Promise<Result<Session, TransportError>>;
  closeSession(sessionId: string): Promise<void>;
  emit(
    sessionId: string,
    content: JsonValue,
    platformTs: Date,
  ): Promise<Result<void, TransportError>>;
  /** Upload an attachment (image, file) as raw bytes to storage. Returns the storage path. */
  uploadAttachment(data: Buffer, mediaType: string): Promise<string>;

  /** Resume an existing conversation by alias or id. Closes any active session on this address, then opens a new one pointing at the resolved conversation. Rejects non-private conversations and conversations not owned by the caller. */
  resumeConversation(
    platformAddress: string,
    platformUserHandle: string,
    target: { alias: string } | { conversationId: string },
  ): Promise<Result<Session, TransportError>>;

  /** Conversation admin. `platformUserHandle` is resolved to a userId for ACL. */
  conversations: {
    list(
      platformUserHandle: string,
    ): Promise<Result<ReadonlyArray<ConversationSummary>, TransportError>>;
    /** Current session's conversation + profile, or null if no active session exists for the address. */
    getCurrent(
      platformUserHandle: string,
      platformAddress: string,
    ): Promise<Result<CurrentConversation | null, TransportError>>;
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
  };

  /** Profile admin. Org profiles (user_id IS NULL) always reject mutations with `access_denied`. */
  profiles: {
    list(platformUserHandle: string): Promise<Result<ReadonlyArray<Profile>, TransportError>>;
    create(
      platformUserHandle: string,
      input: ProfileInput,
    ): Promise<Result<Profile, TransportError>>;
    update(
      platformUserHandle: string,
      profileId: string,
      changes: Partial<ProfileInput>,
    ): Promise<Result<Profile, TransportError>>;
    delete(platformUserHandle: string, profileId: string): Promise<Result<void, TransportError>>;
  };

  /** Model discovery — filtered to `user_selectable = true`. */
  models: {
    list(): Promise<ReadonlyArray<string>>;
  };

  /**
   * Coding-repo registry. Returns `sandbox_disabled` when the sandbox module
   * isn't initialized (no `SANDBOX_RUNTIME` env). Slice-1.0j ships the
   * positional surface; FSM dialog with auto-clone is slice 4.
   */
  repos: {
    list(): Promise<Result<ReadonlyArray<RepoSummary>, TransportError>>;
    add(input: RepoInput): Promise<Result<RepoSummary, TransportError>>;
    remove(name: string): Promise<Result<void, TransportError>>;
  };
}

/**
 * Create a Transport scoped to a channel.
 */
export function createTransport(deps: {
  channelId: string;
  defaultUserId: string;
  defaultProfileId: string;
  transportStore: TransportStore;
  agentStore: AgentStore;
  /**
   * Optional — when undefined, `repos.*` returns `sandbox_disabled`.
   * Bootstrap supplies it whenever the sandbox module is initialized.
   */
  codingStore?: CodingStore;
  inngest: Inngest;
  inboundArrived: typeof InboundArrivedEvent;
  attachments: AttachmentStore;
  idleTimeoutMs: number;
}): Transport {
  const {
    channelId,
    defaultUserId,
    defaultProfileId,
    transportStore,
    agentStore,
    codingStore,
    inngest,
    inboundArrived,
    attachments,
    idleTimeoutMs,
  } = deps;

  return {
    async resolveSession(platformAddress) {
      const session = await transportStore.resolveSession(channelId, platformAddress);
      if (!session) return null;

      // Safety net: expire stale sessions missed by idle timer
      if (idleTimeoutMs > 0) {
        const lastActivity = await agentStore.getLastMessageTime(session.conversationId);
        if (lastActivity && Date.now() - lastActivity.getTime() > idleTimeoutMs) {
          await transportStore.closeSession(session.id);
          logger.warn(
            { sessionId: session.id, conversationId: session.conversationId },
            "session idle-expired via safety net (idle timer may have failed)",
          );
          return null;
        }
      }

      return session;
    },

    async createConversation(platformAddress, platformUserHandle, opts) {
      // Identity resolution: check user_identities for this channel.
      // Wildcard identities (direct channel) accept everyone.
      // Explicit identities (Telegram with allowlist) reject unknown handles.
      const identity = await transportStore.resolveUser(channelId, platformUserHandle);
      if (!identity) {
        return err({ code: "identity_rejected" as const });
      }
      const conv = await agentStore.createConversation({
        userId: identity.userId,
        profileId: opts.profileId ?? defaultProfileId,
        isPrivate: opts.isPrivate,
      });
      const params = {
        channelId,
        platformAddress,
        conversationId: conv.id,
        status: "active" as const,
        receive: "routed" as const,
      };
      const { id } = await transportStore.createSession(params);
      return ok({ id, ...params });
    },

    async closeSession(sessionId) {
      await transportStore.closeSession(sessionId);
    },

    async resumeConversation(platformAddress, platformUserHandle, target) {
      const identity = await transportStore.resolveUser(channelId, platformUserHandle);
      if (!identity) return err({ code: "identity_rejected" as const });

      // Resolve target to a conversationId
      let conversationId: string;
      if ("conversationId" in target) {
        conversationId = target.conversationId;
      } else {
        const row = await agentStore.findConversationByAlias(identity.userId, target.alias);
        if (!row) return err({ code: "conversation_not_found" as const });
        conversationId = row.conversationId;
      }

      // Verify ownership + privacy
      const conv = await agentStore.getConversation(conversationId);
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
          reason: "cannot resume non-private conversation",
        });
      }

      // Atomic close-old + open-new in one transaction, with the "what's active" lookup
      // happening INSIDE the tx so no concurrent createSession / swapSession on this address
      // can slip between resolve and swap. Failure of the insert rolls back the close.
      const newParams = {
        conversationId,
        status: "active" as const,
        receive: "routed" as const,
      };
      const { id } = await transportStore.swapSession(channelId, platformAddress, newParams);
      return ok({ id, channelId, platformAddress, ...newParams });
    },

    async emit(sessionId, content, platformTs) {
      const session = await transportStore.getSession(sessionId);
      if (!session) {
        return err({ code: "session_not_found" as const, sessionId });
      }

      const inbound = await transportStore.persistInbound({
        channelSessionId: sessionId,
        conversationId: session.conversationId,
        content,
        platformTs,
      });

      await inngest.send(
        inboundArrived.create({
          conversationId: session.conversationId,
          inboundMessageId: inbound.id,
        }),
      );

      return ok(undefined);
    },

    async uploadAttachment(data: Buffer, mediaType: string): Promise<string> {
      return attachments.upload(data, mediaType);
    },

    conversations: {
      async list(platformUserHandle) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        return ok(await agentStore.listConversationsForUser(identity.userId));
      },

      async getCurrent(platformUserHandle, platformAddress) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const session = await transportStore.resolveSession(channelId, platformAddress);
        if (!session) return ok(null);
        const conv = await agentStore.getConversation(session.conversationId);
        if (!conv || conv.userId !== identity.userId) return ok(null);
        const profile = await agentStore.getProfile(conv.profileId);
        if (!profile) return err({ code: "profile_not_found" as const });
        return ok({
          conversationId: conv.id,
          profileId: conv.profileId,
          profileName: profile.name,
          model: profile.model,
        });
      },

      async setAlias(platformUserHandle, conversationId, alias) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const conv = await agentStore.getConversation(conversationId);
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
        try {
          await agentStore.setAlias(identity.userId, conversationId, alias);
          return ok(undefined);
        } catch (e) {
          if (e instanceof UniqueViolationError) return err({ code: "alias_taken" as const });
          throw e;
        }
      },

      async setProfile(platformUserHandle, conversationId, profileId) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const conv = await agentStore.getConversation(conversationId);
        if (!conv) return err({ code: "conversation_not_found" as const });
        if (conv.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "conversation not owned by caller",
          });
        }
        // Profile must be visible to the caller (org OR their own).
        const owner = await agentStore.getProfileOwner(profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId !== null && owner.userId !== identity.userId) {
          return err({
            code: "access_denied" as const,
            reason: "profile not visible to caller",
          });
        }
        await agentStore.setConversationProfile(conversationId, profileId);
        return ok(undefined);
      },
    },

    profiles: {
      async list(platformUserHandle) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        return ok(await agentStore.listProfiles(identity.userId));
      },

      async create(platformUserHandle, input) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!(await agentStore.isModelUserSelectable(input.model))) {
          return err({ code: "model_unavailable" as const, model: input.model });
        }
        try {
          const created = await agentStore.createProfile({
            userId: identity.userId,
            name: input.name,
            basePrompt: input.basePrompt,
            model: input.model,
            toolSet: input.toolSet,
          });
          return ok(created);
        } catch (e) {
          if (e instanceof UniqueViolationError)
            return err({ code: "profile_name_taken" as const });
          throw e;
        }
      },

      async update(platformUserHandle, profileId, changes) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const owner = await agentStore.getProfileOwner(profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId === null) {
          return err({
            code: "access_denied" as const,
            reason: "org profiles are read-only via Transport",
          });
        }
        if (owner.userId !== identity.userId) {
          return err({ code: "access_denied" as const, reason: "profile not owned by caller" });
        }
        if (
          changes.model !== undefined &&
          !(await agentStore.isModelUserSelectable(changes.model))
        ) {
          return err({ code: "model_unavailable" as const, model: changes.model });
        }
        try {
          const updated = await agentStore.updateProfile(profileId, changes);
          return ok(updated);
        } catch (e) {
          if (e instanceof UniqueViolationError)
            return err({ code: "profile_name_taken" as const });
          throw e;
        }
      },

      async delete(platformUserHandle, profileId) {
        const identity = await transportStore.resolveUser(channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });
        const owner = await agentStore.getProfileOwner(profileId);
        if (!owner) return err({ code: "profile_not_found" as const });
        if (owner.userId === null) {
          return err({
            code: "access_denied" as const,
            reason: "org profiles cannot be deleted via Transport",
          });
        }
        if (owner.userId !== identity.userId) {
          return err({ code: "access_denied" as const, reason: "profile not owned by caller" });
        }
        try {
          await agentStore.deleteProfile(profileId);
          return ok(undefined);
        } catch (e) {
          if (e instanceof ProfileInUseError) return err({ code: "profile_in_use" as const });
          throw e;
        }
      },
    },

    models: {
      async list() {
        return agentStore.listDistinctUserSelectableModels();
      },
    },

    repos: {
      async list() {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        const rows = await codingStore.listRepos();
        return ok(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            localPath: r.localPath,
            defaultBranch: r.defaultBranch,
            remoteUrl: r.remoteUrl,
            verifyCommand: r.verifyCommand,
          })),
        );
      },
      async add(input) {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        try {
          const row = await codingStore.insertRepo({
            name: input.name,
            localPath: input.localPath,
            defaultBranch: input.defaultBranch ?? "main",
            remoteUrl: input.remoteUrl,
            devcontainer: null,
            allowedBackends: ["claude"],
            // Slice-1 default: a no-op so plan-only tasks have something to
            // record. Slice 4's verify+push step needs a real value before
            // it can use the repo. /repo edit (later) or SQL update for now.
            verifyCommand: input.verifyCommand ?? "true",
            taskTokenBudget: 200_000,
            taskWallTimeSeconds: 1800,
            maxConcurrentTasks: 1,
          });
          return ok({
            id: row.id,
            name: row.name,
            localPath: row.localPath,
            defaultBranch: row.defaultBranch,
            remoteUrl: row.remoteUrl,
            verifyCommand: row.verifyCommand,
          });
        } catch (e) {
          if (e instanceof UniqueViolationError) {
            return err({ code: "repo_name_taken" as const, name: input.name });
          }
          throw e;
        }
      },
      async remove(name) {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        const repo = await codingStore.getRepoByName(name);
        if (!repo) return err({ code: "repo_not_found" as const, name });
        const activeTasks = await codingStore.countActiveTasksForRepo(repo.id);
        if (activeTasks > 0) {
          return err({ code: "repo_in_use" as const, name, activeTasks });
        }
        await codingStore.removeRepo(repo.id);
        return ok(undefined);
      },
    },
  };
}
