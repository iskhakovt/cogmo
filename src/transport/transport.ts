import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Inngest } from "inngest";
import { err, ok, type Result } from "neverthrow";
import type { CodingStore } from "../agent/coding/store/index.js";
import { ProfileInUseError, UniqueViolationError } from "../agent/store/errors.js";
import type { AgentStore, ConversationSummary, Profile, VoiceMode } from "../agent/store/index.js";
import type { ProfileMemoryScope, ToolSet } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import type { inboundArrived as InboundArrivedEvent } from "../inngest/events.js";
import { logger } from "../logger.js";
import {
  type McpServer,
  McpServerConfigSchema,
  type McpServerSpec,
  type McpServerStatus,
} from "../mcp/config.js";
import { McpInvalidServerNameError, McpServerNotFoundError } from "../mcp/errors.js";
import type { McpRegistry } from "../mcp/registry.js";
import { runGit, withGitAskpass } from "../secrets/git-askpass.js";
import {
  DEFAULT_GITHUB_IDENTITY_NAME,
  describeResolveIdentityError,
  resolveGitHubIdentity,
} from "../secrets/github.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { SkillRunner } from "../skills/runner.js";
import type { SkillStore } from "../skills/store/index.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { InboundContent } from "./content.js";
import type { Session, TransportStore } from "./store/index.js";

export interface ProfileInput {
  name: string;
  basePrompt: string;
  model: string;
  toolSet: ToolSet;
  /**
   * Memory ACL: which compartment + trust tag combinations the profile may
   * recall from Hindsight. `null` (default) = no restriction. Set via
   * `/profile scope` after creation; not part of the create dialog.
   */
  memoryScope?: ProfileMemoryScope | null;
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
 * Input for `repos.add` — register a pre-existing local clone. Used by the
 * positional `/repo add <name> <path> <url>` scripting form.
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
  /** Optional override; defaults to `'default'` (the wizard-provisioned bot). */
  identityName?: string;
}

/**
 * Input for `repos.cloneAndAdd` — clone the remote, then register. Used by
 * the slice 4.0c FSM dialog. `localPath` is derived from `${reposDir}/${name}`
 * inside the implementation; the caller doesn't choose it.
 */
export interface RepoCloneAndAddInput {
  name: string;
  remoteUrl: string;
  /** Optional override; defaults to "main" when omitted. */
  defaultBranch?: string;
  /** Optional override; defaults to `"true"` until `/repo edit` ships. */
  verifyCommand?: string;
  /** Optional override; defaults to `'default'` (the wizard-provisioned bot). */
  identityName?: string;
}

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
  | { code: "repo_invalid_input"; field: string; reason: string }
  | { code: "repo_clone_failed"; reason: string }
  | { code: "repo_local_path_exists"; path: string }
  | { code: "github_identity_unavailable"; reason: string }
  | { code: "sandbox_disabled" }
  | { code: "task_not_found"; taskId: string }
  | { code: "task_already_approved"; taskId: string }
  | { code: "task_not_pending_approval"; taskId: string; status: string }
  | { code: "task_already_terminal"; taskId: string; status: string }
  | { code: "skills_disabled" }
  | { code: "skill_deploy_not_found"; pendingId: string }
  | { code: "skill_deploy_not_pending"; pendingId: string; status: string }
  | { code: "skill_deploy_register_failed"; pendingId: string; reason: string }
  | { code: "mcp_disabled" }
  | { code: "mcp_server_not_found"; serverId: string }
  | { code: "mcp_server_name_taken"; name: string }
  | { code: "mcp_invalid_config"; reason: string }
  | { code: "mcp_tool_not_found"; serverId: string; toolName: string }
  | { code: "mcp_connection_failed"; serverId: string; reason: string };

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
    content: InboundContent,
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
    /**
     * Flip a conversation's `status` from `errored` back to `active`. Used
     * by the `/repair` control command — the user-facing escape hatch over
     * the `recover-conversation` automated path. Idempotent: a `/repair`
     * on an already-active conversation returns `wasErrored: false` and
     * succeeds without writing.
     *
     * Identity + ownership checked like `setAlias` / `setProfile` —
     * `identity_rejected` for non-resolved handles, `conversation_not_found`
     * when the row doesn't exist, `access_denied` when the caller doesn't
     * own the conversation.
     */
    repair(
      platformUserHandle: string,
      conversationId: string,
    ): Promise<Result<{ wasErrored: boolean }, TransportError>>;
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
   * isn't initialized (no `SANDBOX_RUNTIME` env).
   */
  repos: {
    list(): Promise<Result<ReadonlyArray<RepoSummary>, TransportError>>;
    /** Register an already-cloned repo by absolute path (positional / scripting form). */
    add(input: RepoInput): Promise<Result<RepoSummary, TransportError>>;
    /**
     * Clone the remote into `${reposDir}/${name}` using the default GitHub
     * identity's PAT, then register it. Used by the slice 4.0c FSM dialog
     * (name → remoteUrl → confirm) so the operator never has to think about
     * paths or pre-clone manually. Returns `github_identity_unavailable`
     * when no identity is provisioned, `repo_local_path_exists` when the
     * target directory is already populated, and `repo_clone_failed` for
     * git-side failures (auth, network, bad URL).
     */
    cloneAndAdd(input: RepoCloneAndAddInput): Promise<Result<RepoSummary, TransportError>>;
    remove(name: string): Promise<Result<void, TransportError>>;
  };

  /**
   * Plan-approval surface for the slice 2.0e Telegram inline keyboard.
   * Each method takes the platform handle of the user who tapped — the
   * implementation resolves it to a userId and rejects with
   * `identity_rejected` if it doesn't match the conversation owner.
   *
   * Returns `sandbox_disabled` when the sandbox module isn't initialized
   * (parallels `repos`).
   */
  coding: {
    /**
     * Stamp `plan_approved_at` and emit `coding/task/plan-approved`. Idempotent:
     * a second tap returns `task_already_approved` instead of re-emitting.
     */
    approvePlan(
      taskId: string,
      tapperPlatformHandle: string,
    ): Promise<Result<{ taskId: string }, TransportError>>;
    /** Set status=`cancelled` with the supplied reason. Idempotent on terminal tasks. */
    cancelTask(
      taskId: string,
      tapperPlatformHandle: string,
      reason: string,
    ): Promise<Result<{ taskId: string }, TransportError>>;
    /**
     * Tool-gate response — emitted when the user taps a button on the
     * permission inline keyboard. Identity-checked against the
     * conversation owner. Transport just emits the
     * `coding/task/permission-decision` event; the orchestrator's
     * `step.waitForEvent` resumes on it.
     */
    respondPermission(
      params: {
        taskId: string;
        requestIdShort: string;
        decision: "allow" | "deny";
        scope: "once" | "task";
      },
      tapperPlatformHandle: string,
    ): Promise<Result<{ taskId: string }, TransportError>>;
  };

  /**
   * Skills-deploy approval surface for the approve-tier inline keyboard.
   * Mirrors the `coding` namespace shape: identity-checked, calls into the
   * existing `SkillRunner` RPCs, returns `Result` with skills-specific
   * error codes. Returns `skills_disabled` when the skills module isn't
   * wired (skipped in some test setups).
   */
  skills: {
    /**
     * Approve a pending-approval deploy by its `skill_deploys.id`. Calls
     * `runner.approveDeploy` which advances main + flips the row live.
     * Idempotent on already-resolved deploys via the underlying store
     * method.
     */
    approveDeploy(
      pendingId: string,
      tapperPlatformHandle: string,
    ): Promise<Result<{ pendingId: string; skillName: string; gitSha: string }, TransportError>>;
    /**
     * Deny a pending-approval deploy. Resolves the row to `denied`; the
     * skills row stays at its existing state (live skill stays live, never-
     * activated skill stays disabled). Idempotent.
     */
    denyDeploy(
      pendingId: string,
      tapperPlatformHandle: string,
      reason?: string,
    ): Promise<Result<{ pendingId: string }, TransportError>>;
  };

  /**
   * MCP server admin surface. Identity-checked: every method takes a
   * `platformUserHandle` resolved against `user_identities`; unknown
   * handles get `identity_rejected`. Returns `mcp_disabled` when bootstrap
   * didn't wire an `McpRegistry` (no MCP servers configured).
   *
   * `addServer` validates the config via `McpServerConfigSchema` (returns
   * `mcp_invalid_config` on parse failure) and creates the row in
   * `pending` state. `approveServer` connects, snapshots tools, and flips
   * the server to `approved` in one transaction. `approveTool` /
   * `rejectTool` flip individual pin status.
   */
  mcp: {
    /**
     * Configured tool budget — the alphabetical drop cap applied per
     * `resolveTools` call. Surfaced sync (no Result wrapping, no ACL)
     * because it's static config the operator can already see in env vars.
     */
    toolBudget(): number;
    addServer(
      platformUserHandle: string,
      spec: McpServerSpec,
    ): Promise<Result<McpServer, TransportError>>;
    removeServer(
      platformUserHandle: string,
      serverId: string,
    ): Promise<Result<void, TransportError>>;
    listServers(
      platformUserHandle: string,
    ): Promise<Result<ReadonlyArray<McpServerStatus>, TransportError>>;
    approveServer(
      platformUserHandle: string,
      serverId: string,
    ): Promise<Result<void, TransportError>>;
    approveTool(
      platformUserHandle: string,
      serverId: string,
      toolName: string,
    ): Promise<Result<void, TransportError>>;
    rejectTool(
      platformUserHandle: string,
      serverId: string,
      toolName: string,
    ): Promise<Result<void, TransportError>>;
  };
}

/**
 * Create a Transport scoped to a channel.
 */
export function createTransport(deps: {
  channelId: string;
  defaultUserId: string;
  defaultProfileId: string;
  runInTx: Transactor;
  transportStore: TransportStore;
  agentStore: AgentStore;
  /**
   * Optional — when undefined, `repos.*` returns `sandbox_disabled`.
   * Bootstrap supplies it whenever the sandbox module is initialized.
   */
  codingStore?: CodingStore;
  /**
   * Optional — when undefined, `repos.cloneAndAdd` returns
   * `github_identity_unavailable`. Bootstrap supplies it once the
   * encrypted-secrets store is initialized.
   */
  secretsStore?: SecretsStore;
  /**
   * Host root for git clones registered via `/repo add`. When undefined,
   * `repos.cloneAndAdd` returns `github_identity_unavailable` (we
   * intentionally re-use the same error rather than introducing a third
   * code; both indicate "the orchestrator can't talk to GitHub yet").
   */
  reposDir?: string;
  /**
   * Skills runner for the approve-tier callback. Optional — when
   * undefined, `skills.*` returns `skills_disabled`. Production wiring
   * always supplies it; some test setups omit.
   */
  skillRunner?: SkillRunner;
  /**
   * Skills store for resolving the deploy → skill → user owner during the
   * Telegram callback identity check. Optional — see `skillRunner`.
   */
  skillStore?: SkillStore;
  /**
   * MCP client registry. Production bootstrap always supplies it (the
   * registry is lazy-connect, so it carries zero cost when unused).
   * Optional only so tests don't have to wire a real registry when they
   * don't exercise `transport.mcp.*` — when absent, every method on the
   * namespace returns `mcp_disabled`.
   */
  mcpRegistry?: McpRegistry;
  inngest: Inngest;
  inboundArrived: typeof InboundArrivedEvent;
  attachments: AttachmentStore;
  idleTimeoutMs: number;
}): Transport {
  const {
    channelId,
    defaultProfileId,
    runInTx,
    transportStore,
    agentStore,
    codingStore,
    secretsStore,
    reposDir,
    skillRunner,
    skillStore,
    mcpRegistry,
    inngest,
    inboundArrived,
    attachments,
    idleTimeoutMs,
  } = deps;

  return {
    async resolveSession(platformAddress) {
      const session = await runInTx((tx) =>
        transportStore.resolveSession(tx, channelId, platformAddress),
      );
      if (!session) return null;

      // Safety net: expire stale sessions missed by idle timer
      if (idleTimeoutMs > 0) {
        const lastActivity = await runInTx((tx) =>
          agentStore.getLastMessageTime(tx, session.conversationId),
        );
        if (lastActivity && Date.now() - lastActivity.getTime() > idleTimeoutMs) {
          await runInTx((tx) => transportStore.closeSession(tx, session.id));
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
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) {
          return err({ code: "identity_rejected" as const });
        }
        const conv = await agentStore.createConversation(tx, {
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
        const { id } = await transportStore.createSession(tx, params);
        return ok({ id, ...params });
      });
    },

    async closeSession(sessionId) {
      await runInTx((tx) => transportStore.closeSession(tx, sessionId));
    },

    async resumeConversation(platformAddress, platformUserHandle, target) {
      return runInTx(async (tx) => {
        const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
        if (!identity) return err({ code: "identity_rejected" as const });

        // Resolve target to a conversationId
        let conversationId: string;
        if ("conversationId" in target) {
          conversationId = target.conversationId;
        } else {
          const row = await agentStore.findConversationByAlias(tx, identity.userId, target.alias);
          if (!row) return err({ code: "conversation_not_found" as const });
          conversationId = row.conversationId;
        }

        // Verify ownership + privacy
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
        const { id } = await transportStore.swapSession(tx, channelId, platformAddress, newParams);
        return ok({ id, channelId, platformAddress, ...newParams });
      });
    },

    async emit(sessionId, content, platformTs) {
      const inbound = await runInTx(async (tx) => {
        const session = await transportStore.getSession(tx, sessionId);
        if (!session) {
          return null;
        }

        const inbound = await transportStore.persistInbound(tx, {
          channelSessionId: sessionId,
          conversationId: session.conversationId,
          content,
          platformTs,
        });
        return { conversationId: session.conversationId, inboundId: inbound.id };
      });

      if (!inbound) {
        return err({ code: "session_not_found" as const, sessionId });
      }

      await inngest.send(
        inboundArrived.create({
          conversationId: inbound.conversationId,
          inboundMessageId: inbound.inboundId,
        }),
      );

      return ok(undefined);
    },

    async uploadAttachment(data: Buffer, mediaType: string): Promise<string> {
      return attachments.upload(data, mediaType);
    },

    conversations: {
      async list(platformUserHandle) {
        return runInTx(async (tx) => {
          const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
          if (!identity) return err({ code: "identity_rejected" as const });
          return ok(await agentStore.listConversationsForUser(tx, identity.userId));
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
          try {
            await agentStore.setAlias(tx, identity.userId, conversationId, alias);
            return ok(undefined);
          } catch (e) {
            if (e instanceof UniqueViolationError) return err({ code: "alias_taken" as const });
            throw e;
          }
        });
      },

      async setProfile(platformUserHandle, conversationId, profileId) {
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
          return ok(undefined);
        });
      },

      async repair(platformUserHandle, conversationId) {
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
          const wasErrored = conv.status === "errored";
          // Idempotent: skip the write when already active. Saves a row update
          // and lets the command surface "already active" cleanly.
          if (wasErrored) {
            await agentStore.setConversationStatus(tx, conversationId, "active");
          }
          return ok({ wasErrored });
        });
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
    },

    profiles: {
      async list(platformUserHandle) {
        return runInTx(async (tx) => {
          const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
          if (!identity) return err({ code: "identity_rejected" as const });
          return ok(await agentStore.listProfiles(tx, identity.userId));
        });
      },

      async create(platformUserHandle, input) {
        return runInTx(async (tx) => {
          const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
          if (!identity) return err({ code: "identity_rejected" as const });
          if (!(await agentStore.isModelUserSelectable(tx, input.model))) {
            return err({ code: "model_unavailable" as const, model: input.model });
          }
          try {
            const created = await agentStore.createProfile(tx, {
              userId: identity.userId,
              name: input.name,
              basePrompt: input.basePrompt,
              model: input.model,
              toolSet: input.toolSet,
              ...(input.memoryScope !== undefined && { memoryScope: input.memoryScope }),
            });
            return ok(created);
          } catch (e) {
            if (e instanceof UniqueViolationError)
              return err({ code: "profile_name_taken" as const });
            throw e;
          }
        });
      },

      async update(platformUserHandle, profileId, changes) {
        return runInTx(async (tx) => {
          const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
          if (!identity) return err({ code: "identity_rejected" as const });
          const owner = await agentStore.getProfileOwner(tx, profileId);
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
            !(await agentStore.isModelUserSelectable(tx, changes.model))
          ) {
            return err({ code: "model_unavailable" as const, model: changes.model });
          }
          try {
            const updated = await agentStore.updateProfile(tx, profileId, changes);
            return ok(updated);
          } catch (e) {
            if (e instanceof UniqueViolationError)
              return err({ code: "profile_name_taken" as const });
            throw e;
          }
        });
      },

      async delete(platformUserHandle, profileId) {
        return runInTx(async (tx) => {
          const identity = await transportStore.resolveUser(tx, channelId, platformUserHandle);
          if (!identity) return err({ code: "identity_rejected" as const });
          const owner = await agentStore.getProfileOwner(tx, profileId);
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
            await agentStore.deleteProfile(tx, profileId);
            return ok(undefined);
          } catch (e) {
            if (e instanceof ProfileInUseError) return err({ code: "profile_in_use" as const });
            throw e;
          }
        });
      },
    },

    models: {
      async list() {
        return runInTx((tx) => agentStore.listDistinctUserSelectableModels(tx));
      },
    },

    repos: {
      async list() {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        const rows = await runInTx((tx) => codingStore.listRepos(tx));
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
        // Input validation — `name` becomes a path segment under
        // worktreesDir, so it must be a safe identifier. `localPath` must
        // be absolute (relative would resolve against Cogmo's CWD, which
        // changes between dev and prod). `remoteUrl` is opaque to slice 1
        // (we only `git -C localPath` operations), but slice 4 will pass
        // it to `git push` — empty-string check is enough for now.
        const validation = validateRepoInput(input);
        if (validation) return err(validation);
        try {
          const row = await runInTx((tx) =>
            codingStore.insertRepo(tx, {
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
              ...(input.identityName !== undefined && { identityName: input.identityName }),
            }),
          );
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
      async cloneAndAdd(input) {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        if (!secretsStore || !reposDir) {
          return err({
            code: "github_identity_unavailable" as const,
            reason:
              "Encrypted secrets or repos directory not configured; run setup before /repo add.",
          });
        }
        const identityName = input.identityName ?? DEFAULT_GITHUB_IDENTITY_NAME;
        const secretsStoreLocal = secretsStore;
        const identity = await runInTx((tx) =>
          resolveGitHubIdentity(tx, secretsStoreLocal, identityName),
        );
        if (identity.isErr()) {
          return err({
            code: "github_identity_unavailable" as const,
            reason: describeResolveIdentityError(identity.error),
          });
        }

        const localPath = join(reposDir, input.name);
        const validation = validateRepoInput({
          name: input.name,
          localPath,
          remoteUrl: input.remoteUrl,
        });
        if (validation) return err(validation);

        // Pre-check the registry by name — otherwise we'd clone (slow, network
        // egress, Gitea/GitHub side effects) and only fail on the DB insert,
        // leaving an orphaned working tree on disk that the operator has to
        // clean up by hand. Tiny TOCTOU window between this check and
        // `insertRepo` below; UNIQUE(name) still catches the race so the
        // worst case is the rare orphan rather than the common one.
        const existing = await runInTx((tx) => codingStore.getRepoByName(tx, input.name));
        if (existing) {
          return err({ code: "repo_name_taken" as const, name: input.name });
        }

        if (existsSync(localPath)) {
          return err({ code: "repo_local_path_exists" as const, path: localPath });
        }

        if (!existsSync(reposDir)) {
          mkdirSync(reposDir, { recursive: true, mode: 0o700 });
        }

        try {
          await withGitAskpass(identity.value.pat, async (env) => {
            await runGit(["clone", "--quiet", input.remoteUrl, localPath], env);
          });
        } catch (e) {
          return err({
            code: "repo_clone_failed" as const,
            reason: (e as Error).message,
          });
        }

        try {
          const row = await runInTx((tx) =>
            codingStore.insertRepo(tx, {
              name: input.name,
              localPath,
              defaultBranch: input.defaultBranch ?? "main",
              remoteUrl: input.remoteUrl,
              devcontainer: null,
              allowedBackends: ["claude"],
              verifyCommand: input.verifyCommand ?? "true",
              taskTokenBudget: 200_000,
              taskWallTimeSeconds: 1800,
              maxConcurrentTasks: 1,
              ...(input.identityName !== undefined && { identityName: input.identityName }),
            }),
          );
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
        // Resolve name → id outside the atomic check (the name lookup itself
        // doesn't race meaningfully — names are unique). The active-task
        // count + delete run inside one transaction in `removeRepoIfIdle`,
        // so a concurrent `insertTask` can't slip past the count.
        const repo = await runInTx((tx) => codingStore.getRepoByName(tx, name));
        if (!repo) return err({ code: "repo_not_found" as const, name });
        const result = await runInTx((tx) => codingStore.removeRepoIfIdle(tx, repo.id));
        switch (result.kind) {
          case "deleted":
            return ok(undefined);
          case "in_use":
            return err({ code: "repo_in_use" as const, name, activeTasks: result.activeTasks });
          case "not_found":
            // Race window: repo existed at getRepoByName but was deleted
            // between the lookup and the atomic check. Surface as
            // not_found rather than synthesizing a stale success.
            return err({ code: "repo_not_found" as const, name });
        }
      },
    },

    coding: {
      async approvePlan(taskId, tapperPlatformHandle) {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        const identityCheck = await checkTaskOwnership(taskId, tapperPlatformHandle);
        if (identityCheck.isErr()) return err(identityCheck.error);
        // Capture the timestamp once and reuse it for both the DB row
        // and the Inngest event payload — the receiver downstream can
        // trust them to match without a second clock read.
        const approvedAt = new Date();
        const result = await runInTx((tx) =>
          codingStore.approvePlanIfPending(tx, taskId, approvedAt),
        );
        switch (result.kind) {
          case "approved":
            await inngest.send({
              name: "coding/task/plan-approved",
              data: { taskId, approvedAt: approvedAt.toISOString() },
            });
            return ok({ taskId });
          case "already_approved":
            return err({ code: "task_already_approved" as const, taskId });
          case "not_pending":
            return err({
              code: "task_not_pending_approval" as const,
              taskId,
              status: result.status,
            });
          case "not_found":
            return err({ code: "task_not_found" as const, taskId });
        }
      },
      async cancelTask(taskId, tapperPlatformHandle, reason) {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        const identityCheck = await checkTaskOwnership(taskId, tapperPlatformHandle);
        if (identityCheck.isErr()) return err(identityCheck.error);
        const result = await runInTx((tx) => codingStore.cancelTaskIfActive(tx, taskId, reason));
        switch (result.kind) {
          case "cancelled":
            return ok({ taskId });
          case "already_terminal":
            return err({
              code: "task_already_terminal" as const,
              taskId,
              status: result.status,
            });
          case "not_found":
            return err({ code: "task_not_found" as const, taskId });
        }
      },
      async respondPermission(params, tapperPlatformHandle) {
        if (!codingStore) return err({ code: "sandbox_disabled" as const });
        const identityCheck = await checkTaskOwnership(params.taskId, tapperPlatformHandle);
        if (identityCheck.isErr()) return err(identityCheck.error);
        // No DB transition here — the orchestrator's `step.waitForEvent`
        // resumes on this Inngest event and applies (decision, scope) to
        // the decision log itself. Idempotency at this layer would
        // require de-duplicating the event; not necessary because the
        // orchestrator's wait matches on `requestId` and only the first
        // arriving event satisfies the wait. Subsequent taps emit but
        // don't unblock anything — they're harmless.
        await inngest.send({
          name: "coding/task/permission-decision",
          data: {
            taskId: params.taskId,
            requestId: params.requestIdShort,
            decision: params.decision,
            scope: params.scope,
          },
        });
        return ok({ taskId: params.taskId });
      },
    },

    skills: {
      async approveDeploy(pendingId, tapperPlatformHandle) {
        if (!skillRunner || !skillStore) return err({ code: "skills_disabled" as const });
        const identityCheck = await checkSkillsTapper(tapperPlatformHandle);
        if (identityCheck.isErr()) return err(identityCheck.error);

        // Pre-check the deploy's status so we can return a precise error
        // code when it's already resolved (avoids the `runner.approveDeploy
        // → "rejected"` → string-parsing dance). Race window: the deploy
        // could resolve between this read and the actual approve call;
        // that's fine — runner.approveDeploy is itself atomic and the
        // worst case is we return "live" when the user expected
        // already-resolved.
        const deploy = await runInTx((tx) => skillStore.getDeployById(tx, pendingId));
        if (!deploy) return err({ code: "skill_deploy_not_found" as const, pendingId });
        if (deploy.status !== "pending_approval") {
          return err({
            code: "skill_deploy_not_pending" as const,
            pendingId,
            status: deploy.status,
          });
        }

        const result = await skillRunner.approveDeploy({
          pendingId,
          approvedBy: tapperPlatformHandle,
        });
        if (result.status === "live") {
          return ok({
            pendingId,
            skillName: result.name,
            gitSha: result.gitSha,
          });
        }
        // Runner rejected — surface the runner's reason verbatim so the
        // Telegram callback handler can show a useful toast.
        return err({
          code: "skill_deploy_register_failed" as const,
          pendingId,
          reason: result.errors?.[0] ?? `unexpected status '${result.status}'`,
        });
      },
      async denyDeploy(pendingId, tapperPlatformHandle, reason) {
        if (!skillRunner || !skillStore) return err({ code: "skills_disabled" as const });
        const identityCheck = await checkSkillsTapper(tapperPlatformHandle);
        if (identityCheck.isErr()) return err(identityCheck.error);

        const deploy = await runInTx((tx) => skillStore.getDeployById(tx, pendingId));
        if (!deploy) return err({ code: "skill_deploy_not_found" as const, pendingId });
        // denyDeploy is idempotent on already-resolved deploys (the store
        // method skips the update + returns silently). We still surface a
        // distinct error code for clarity at this layer — a tap on an
        // already-denied keyboard should toast "already resolved", not
        // "denied successfully".
        if (deploy.status !== "pending_approval") {
          return err({
            code: "skill_deploy_not_pending" as const,
            pendingId,
            status: deploy.status,
          });
        }
        await skillRunner.denyDeploy({
          pendingId,
          ...(reason !== undefined && { reason }),
        });
        return ok({ pendingId });
      },
    },

    // Identity check runs FIRST in every method below (before the
    // `mcp_disabled` short-circuit) so an unauthenticated handle can't
    // probe whether MCP is wired in this deployment. `toolBudget` is the
    // exception — static config, no auth gate.
    mcp: {
      toolBudget() {
        return mcpRegistry?.toolBudget() ?? 0;
      },
      async addServer(platformUserHandle, spec) {
        const identity = await runInTx((tx) =>
          transportStore.resolveUser(tx, channelId, platformUserHandle),
        );
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
        // Validate the config blob before any DB write so a malformed paste
        // surfaces a structured `mcp_invalid_config` instead of a Zod throw.
        const parsed = McpServerConfigSchema.safeParse(spec.config);
        if (!parsed.success) {
          return err({
            code: "mcp_invalid_config" as const,
            reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          });
        }
        try {
          const server = await mcpRegistry.addServer({
            name: spec.name,
            config: parsed.data,
            enabled: spec.enabled,
          });
          return ok(server);
        } catch (e) {
          if (e instanceof UniqueViolationError)
            return err({ code: "mcp_server_name_taken" as const, name: spec.name });
          if (e instanceof McpInvalidServerNameError)
            return err({ code: "mcp_invalid_config" as const, reason: e.message });
          throw e;
        }
      },

      async removeServer(platformUserHandle, serverId) {
        const identity = await runInTx((tx) =>
          transportStore.resolveUser(tx, channelId, platformUserHandle),
        );
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
        await mcpRegistry.removeServer(serverId);
        return ok(undefined);
      },

      async listServers(platformUserHandle) {
        const identity = await runInTx((tx) =>
          transportStore.resolveUser(tx, channelId, platformUserHandle),
        );
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
        const servers = await mcpRegistry.listServers();
        return ok(servers);
      },

      async approveServer(platformUserHandle, serverId) {
        const identity = await runInTx((tx) =>
          transportStore.resolveUser(tx, channelId, platformUserHandle),
        );
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
        try {
          await mcpRegistry.approveServer(serverId);
          return ok(undefined);
        } catch (e) {
          if (e instanceof McpServerNotFoundError)
            return err({ code: "mcp_server_not_found" as const, serverId: e.serverId });
          // Connect / listTools failure surfaces as a Result error so the
          // Telegram callback can render a precise toast.
          return err({
            code: "mcp_connection_failed" as const,
            serverId,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      },

      async approveTool(platformUserHandle, serverId, toolName) {
        const identity = await runInTx((tx) =>
          transportStore.resolveUser(tx, channelId, platformUserHandle),
        );
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
        const updated = await mcpRegistry.approveTool(serverId, toolName);
        if (!updated) return err({ code: "mcp_tool_not_found" as const, serverId, toolName });
        return ok(undefined);
      },

      async rejectTool(platformUserHandle, serverId, toolName) {
        const identity = await runInTx((tx) =>
          transportStore.resolveUser(tx, channelId, platformUserHandle),
        );
        if (!identity) return err({ code: "identity_rejected" as const });
        if (!mcpRegistry) return err({ code: "mcp_disabled" as const });
        const updated = await mcpRegistry.rejectTool(serverId, toolName);
        if (!updated) return err({ code: "mcp_tool_not_found" as const, serverId, toolName });
        return ok(undefined);
      },
    },
  };

  /**
   * Strict identity check for task callbacks: the user who tapped the
   * keyboard must own the conversation that triggered the task. Resolves
   * the platform handle to a Cogmo userId via `transportStore.resolveUser`
   * and compares against `coding_tasks.conversation_id →
   * conversations.user_id`.
   *
   * Caveat: in single-user wildcard mode, `resolveUser` returns the same
   * userId for any platform handle — the check degenerates to "is this
   * channel known to Cogmo?". That's fine for personal deployments.
   * Multi-user channels with explicit identities (`auto_created=false`,
   * non-null `platform_handle`) get the strict comparison.
   */
  async function checkTaskOwnership(
    taskId: string,
    tapperPlatformHandle: string,
  ): Promise<Result<void, TransportError>> {
    if (!codingStore) return err({ code: "sandbox_disabled" as const });
    const task = await runInTx((tx) => codingStore.getTask(tx, taskId));
    if (!task) return err({ code: "task_not_found" as const, taskId });
    const taskConversationId = task.conversationId;
    if (!taskConversationId) {
      // Automated triggers (evolution, signal_pipeline) have no
      // conversation owner — there's no Telegram callback path for them
      // either, so this branch is defensive.
      return err({ code: "operation_not_permitted" as const });
    }
    return runInTx(async (tx) => {
      const conv = await agentStore.getConversation(tx, taskConversationId);
      if (!conv) return err({ code: "conversation_not_found" as const });
      const tapper = await transportStore.resolveUser(tx, channelId, tapperPlatformHandle);
      if (!tapper || tapper.userId !== conv.userId) {
        return err({ code: "identity_rejected" as const });
      }
      return ok(undefined);
    });
  }

  /**
   * Identity check for skills-deploy callbacks. Skills aren't bound to a
   * conversation (they live on the user, not on a chat), so the check is
   * "is the tapper a known user of this channel". `resolveUser` returns
   * non-null iff the platform handle is allowlisted; that's the same gate
   * the inbound message path already enforces.
   *
   * Caveat (same as checkTaskOwnership): single-user wildcard mode resolves
   * any handle to the same userId, so this degenerates to "channel is
   * known". Acceptable at personal scale; multi-user deployments get the
   * stricter handle→userId mapping for free.
   */
  async function checkSkillsTapper(
    tapperPlatformHandle: string,
  ): Promise<Result<void, TransportError>> {
    const tapper = await runInTx((tx) =>
      transportStore.resolveUser(tx, channelId, tapperPlatformHandle),
    );
    if (!tapper) {
      return err({ code: "identity_rejected" as const });
    }
    return ok(undefined);
  }
}

/**
 * Validate `RepoInput` for shape constraints that the schema can't enforce
 * (the DB is text, but we have semantic constraints for filesystem safety).
 * Returns a `TransportError` to surface, or `null` if input is valid.
 */
const REPO_NAME_RE = /^[a-zA-Z0-9._-]+$/;
function validateRepoInput(input: {
  name: string;
  localPath: string;
  remoteUrl: string;
}): { code: "repo_invalid_input"; field: string; reason: string } | null {
  if (!REPO_NAME_RE.test(input.name)) {
    return {
      code: "repo_invalid_input",
      field: "name",
      reason: "must match [a-zA-Z0-9._-]+ (no path separators, spaces, or shell metacharacters)",
    };
  }
  // Reject `.` / `..` even though they pass the alphabet — `path.join(reposDir,
  // "..")` escapes the intended subtree, and `repo add . /...` would treat the
  // whole reposDir as a single repo. Empty-after-strip is impossible here
  // (regex requires at least one char) but guard anyway.
  if (input.name === "." || input.name === "..") {
    return {
      code: "repo_invalid_input",
      field: "name",
      reason: "must not be '.' or '..'",
    };
  }
  if (!isAbsolute(input.localPath)) {
    return {
      code: "repo_invalid_input",
      field: "localPath",
      reason: "must be an absolute path (resolved against Cogmo's CWD otherwise)",
    };
  }
  if (input.remoteUrl.trim() === "") {
    return {
      code: "repo_invalid_input",
      field: "remoteUrl",
      reason: "must not be empty",
    };
  }
  return null;
}
