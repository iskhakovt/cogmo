/**
 * Shared mock factories for unit tests.
 * Every store interface method is mocked — tests override what they need.
 */
import type { Inngest } from "inngest";
import { ok } from "neverthrow";
import { vi } from "vitest";
import type { AgentStore } from "../agent/store/index.js";
import type { ToolRegistry } from "../agent/tools.js";
import type { LlmProvider } from "../llm/provider.js";
import { constantResolver, type LlmProviderResolver } from "../llm/resolver.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import type { DeliveryHandle, DeliveryRouter } from "../transport/delivery-router.js";
import type { TransportStore } from "../transport/store/index.js";
import type { Transport } from "../transport/transport.js";
import type { Adapter, StreamHandle, StreamingAdapter } from "../transport/types.js";

export function mockAgentStore(overrides?: Partial<AgentStore>): AgentStore {
  return {
    createUser: vi.fn().mockResolvedValue({ id: "user-1" }),
    getFirstUser: vi.fn().mockResolvedValue({ id: "user-1" }),
    createConversation: vi.fn().mockResolvedValue({ id: "conv-1" }),
    getConversation: vi.fn().mockResolvedValue({
      id: "conv-1",
      userId: "user-1",
      profileId: "profile-1",
      isPrivate: true,
      status: "active",
      voiceMode: null,
    }),
    setConversationStatus: vi.fn().mockResolvedValue(undefined),
    setConversationVoiceMode: vi.fn().mockResolvedValue(undefined),
    getVoiceConfig: vi.fn().mockResolvedValue(undefined),
    upsertVoiceConfig: vi.fn().mockResolvedValue({ id: "voice-config-1" }),
    deleteVoiceConfig: vi.fn().mockResolvedValue(undefined),
    insertMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    insertMessages: vi.fn().mockResolvedValue({ id: "msg-1" }),
    getLastAssistantMessage: vi.fn().mockResolvedValue(null),
    getHistory: vi.fn().mockResolvedValue([]),
    getProfile: vi.fn().mockResolvedValue({
      id: "profile-1",
      userId: null,
      name: "assistant",
      basePrompt: "test",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass: null,
    }),
    getDefaultProfile: vi.fn().mockResolvedValue({ id: "profile-1" }),
    createProfile: vi.fn().mockResolvedValue({
      id: "profile-1",
      userId: null,
      name: "assistant",
      basePrompt: "",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass: null,
    }),
    getActiveRules: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue({ id: "msg-1", role: "assistant", content: "test" }),
    getCoreMemoryBlocks: vi.fn().mockResolvedValue([]),
    upsertCoreMemoryBlock: vi.fn().mockResolvedValue(undefined),
    getLastMessageTime: vi.fn().mockResolvedValue(null),
    getLastTokens: vi.fn().mockResolvedValue(null),
    createProvider: vi.fn().mockResolvedValue({ id: "provider-1" }),
    getProvider: vi.fn().mockResolvedValue(null),
    listProviders: vi.fn().mockResolvedValue([]),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    addModelProvider: vi.fn().mockResolvedValue({ id: "mp-1" }),
    listProvidersForModel: vi.fn().mockResolvedValue([]),
    getNextModelProviderPosition: vi.fn().mockResolvedValue(0),
    removeModelProvidersByProvider: vi.fn().mockResolvedValue(undefined),
    removeModelProvider: vi.fn().mockResolvedValue(undefined),
    listAllModels: vi.fn().mockResolvedValue([]),
    listAllModelProviders: vi.fn().mockResolvedValue([]),
    createImageProvider: vi.fn().mockResolvedValue({ id: "image-provider-1" }),
    getImageProvider: vi.fn().mockResolvedValue(undefined),
    findImageProviderByName: vi.fn().mockResolvedValue(undefined),
    listImageProviders: vi.fn().mockResolvedValue([]),
    deleteImageProvider: vi.fn().mockResolvedValue(undefined),
    createImageModel: vi.fn().mockResolvedValue({ id: "image-model-1" }),
    upsertImageModelsByName: vi.fn().mockResolvedValue(0),
    listImageModels: vi.fn().mockResolvedValue([]),
    listImageModelsWithProvider: vi.fn().mockResolvedValue([]),
    deleteImageModel: vi.fn().mockResolvedValue(undefined),
    listProfileClasses: vi.fn().mockResolvedValue([]),
    createProfileClass: vi.fn().mockResolvedValue({
      id: "class-1",
      userId: "user-1",
      name: "intimate",
      description: "test",
      restricted: false,
      createdAt: new Date("2026-04-16T12:00:00Z"),
    }),
    deleteProfileClass: vi.fn().mockResolvedValue({ deleted: true }),
    setProfileClass: vi.fn().mockResolvedValue(undefined),
    setProfileClassRestricted: vi.fn().mockResolvedValue({ updated: true }),
    listCustomCompartments: vi.fn().mockResolvedValue([]),
    createCustomCompartment: vi.fn().mockResolvedValue({
      id: "cc-1",
      userId: "user-1",
      name: "dnd",
      description: "test",
      createdAt: new Date("2026-05-09T12:00:00Z"),
    }),
    deleteCustomCompartment: vi.fn().mockResolvedValue({ deleted: true }),
    hasChannelRules: vi.fn().mockResolvedValue(false),
    insertManualRule: vi.fn().mockResolvedValue({ id: "rule-1" }),
    getCorrections: vi.fn().mockResolvedValue([]),
    upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: false }),
    countActiveRules: vi.fn().mockResolvedValue(0),
    replaceRules: vi.fn().mockResolvedValue({ id: "rule-1" }),
    stagePendingMemory: vi.fn().mockResolvedValue({ id: "pending-1" }),
    bulkStagePendingMemories: vi.fn().mockResolvedValue(undefined),
    getPendingMemories: vi.fn().mockResolvedValue([]),
    deletePendingMemories: vi.fn().mockResolvedValue(undefined),
    createScheduledTask: vi.fn().mockResolvedValue({
      id: "sched-1",
      userId: "user-1",
      profileId: "profile-1",
      kind: "recurring",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "test",
      nextRunAt: new Date(0),
      lastRunAt: null,
      enabled: true,
      catchupMissed: false,
      source: "agent",
      createdAt: new Date(0),
    }),
    getScheduledTask: vi.fn().mockResolvedValue(undefined),
    listScheduledTasks: vi.fn().mockResolvedValue([]),
    lockDueScheduledTasks: vi.fn().mockResolvedValue([]),
    advanceScheduledTask: vi.fn().mockResolvedValue(undefined),
    setScheduledTaskEnabled: vi.fn().mockResolvedValue(undefined),
    deleteScheduledTask: vi.fn().mockResolvedValue(undefined),
    // --- Admin (Chunk 3) ---
    listProfiles: vi.fn().mockResolvedValue([]),
    getProfileOwner: vi.fn().mockResolvedValue(null),
    updateProfile: vi.fn().mockResolvedValue({
      id: "profile-1",
      userId: null,
      name: "test",
      basePrompt: "",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass: null,
    }),
    countProfileReferences: vi.fn().mockResolvedValue({ conversations: 0, messages: 0 }),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    setConversationProfile: vi.fn().mockResolvedValue(undefined),
    setAlias: vi.fn().mockResolvedValue(undefined),
    findConversationByAlias: vi.fn().mockResolvedValue(null),
    getAliasForConversation: vi.fn().mockResolvedValue(null),
    getConversationStats: vi.fn().mockResolvedValue({
      createdAt: new Date("2026-04-16T12:00:00Z"),
      messageCount: 0,
      lastMessageAt: null,
    }),
    listDistinctUserSelectableModels: vi.fn().mockResolvedValue([]),
    isModelUserSelectable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

export function mockTransportStore(overrides?: Partial<TransportStore>): TransportStore {
  return {
    getAllChannels: vi.fn().mockResolvedValue([]),
    getChannelByType: vi.fn().mockResolvedValue(null),
    createChannel: vi.fn().mockResolvedValue({ id: "ch-1" }),
    resolveSession: vi.fn().mockResolvedValue(null),
    createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
    closeSession: vi.fn().mockResolvedValue(undefined),
    swapSession: vi.fn().mockResolvedValue({ id: "session-swapped" }),
    getSession: vi.fn().mockResolvedValue(null),
    persistInbound: vi.fn().mockResolvedValue({ id: "inbound-1" }),
    getUnbatchedInbound: vi.fn().mockResolvedValue([{ id: "inbound-1", content: "hello" }]),
    getActiveSessionsForConversation: vi.fn().mockResolvedValue([]),
    getActiveChannelTypes: vi.fn().mockResolvedValue([]),
    getVoiceMaxReplyChars: vi.fn().mockResolvedValue(null),
    getSourceSessions: vi.fn().mockResolvedValue([]),
    getReceiveAllSessions: vi.fn().mockResolvedValue([]),
    resolveUser: vi.fn().mockResolvedValue({ userId: "user-1" }),
    createWildcardIdentity: vi.fn().mockResolvedValue({ id: "identity-1" }),
    createIdentity: vi.fn().mockResolvedValue({ id: "identity-1" }),
    updateChannelCredentials: vi.fn().mockResolvedValue(undefined),
    removeChannel: vi.fn().mockResolvedValue(undefined),
    getChatDefaultProfile: vi.fn().mockResolvedValue(undefined),
    setChatDefaultProfile: vi.fn().mockResolvedValue(undefined),
    clearChatDefaultProfile: vi.fn().mockResolvedValue(undefined),
    findActiveSessionForUserProfile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Functions / Date / RegExp stay as leaves in DeepPartial so a test can
// override one method on a sub-namespace (`conversations`, `profiles`,
// etc.) without TypeScript trying to recurse into the function signature.
// biome-ignore lint/complexity/noBannedTypes: Function leaf type is intentional
type Leaf = Function | Date | RegExp;
export type DeepPartial<T> = T extends Leaf
  ? T
  : { [K in keyof T]?: T[K] extends Leaf ? T[K] : DeepPartial<T[K]> };

/**
 * Like `mockTransport` but deep-merges the override into each Transport
 * sub-namespace. Tests can pass `{ conversations: { list: vi.fn()... } }`
 * and pick up the default mocks for `getCurrent`, `summary`, etc.
 */
export function mockTransportDeep(overrides: DeepPartial<Transport> = {}): Transport {
  const base = mockTransport();
  return {
    ...base,
    ...overrides,
    conversations: { ...base.conversations, ...(overrides.conversations ?? {}) },
    chats: { ...base.chats, ...(overrides.chats ?? {}) },
    profiles: { ...base.profiles, ...(overrides.profiles ?? {}) },
    profileClasses: { ...base.profileClasses, ...(overrides.profileClasses ?? {}) },
    compartments: { ...base.compartments, ...(overrides.compartments ?? {}) },
    models: { ...base.models, ...(overrides.models ?? {}) },
    repos: { ...base.repos, ...(overrides.repos ?? {}) },
    coding: { ...base.coding, ...(overrides.coding ?? {}) },
    skills: { ...base.skills, ...(overrides.skills ?? {}) },
    mcp: { ...base.mcp, ...(overrides.mcp ?? {}) },
  };
}

export function mockTransport(overrides?: Partial<Transport>): Transport {
  return {
    resolveSession: vi.fn().mockResolvedValue(null),
    createConversation: vi.fn().mockResolvedValue(
      ok({
        id: "session-1",
        channelId: "ch-1",
        platformAddress: "addr",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
        profileName: "assistant",
      }),
    ),
    closeSession: vi.fn().mockResolvedValue(undefined),
    resumeConversation: vi.fn().mockResolvedValue(
      ok({
        id: "session-resumed",
        channelId: "ch-1",
        platformAddress: "addr",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
      }),
    ),
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    uploadAttachment: vi.fn().mockResolvedValue("inbound/test.jpg"),
    conversations: {
      list: vi.fn().mockResolvedValue(ok([])),
      getCurrent: vi.fn().mockResolvedValue(ok(null)),
      summary: vi.fn().mockResolvedValue(ok(null)),
      setAlias: vi.fn().mockResolvedValue(ok(undefined)),
      setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      repair: vi.fn().mockResolvedValue(ok({ wasErrored: false })),
      setVoiceMode: vi.fn().mockResolvedValue(ok(undefined)),
    },
    chats: {
      getDefaultProfile: vi.fn().mockResolvedValue(ok(null)),
      setDefaultProfile: vi.fn().mockResolvedValue(ok(undefined)),
      clearDefaultProfile: vi.fn().mockResolvedValue(ok(undefined)),
    },
    profiles: {
      list: vi.fn().mockResolvedValue(ok([])),
      create: vi.fn().mockResolvedValue(
        ok({
          id: "profile-new",
          userId: "user-1",
          name: "test",
          basePrompt: "",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          voiceMode: "auto",
          toolSet: [],
          memoryScope: null,
        }),
      ),
      update: vi.fn().mockResolvedValue(
        ok({
          id: "profile-1",
          userId: "user-1",
          name: "test",
          basePrompt: "",
          model: "claude-sonnet-4-6",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          voiceMode: "auto",
          toolSet: [],
          memoryScope: null,
        }),
      ),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
      setClass: vi.fn().mockResolvedValue(ok(undefined)),
    },
    profileClasses: {
      list: vi.fn().mockResolvedValue(ok([])),
      create: vi.fn().mockResolvedValue(
        ok({
          id: "class-1",
          userId: "user-1",
          name: "intimate",
          description: "test",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        }),
      ),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
      setRestricted: vi.fn().mockResolvedValue(ok(undefined)),
    },
    compartments: {
      list: vi.fn().mockResolvedValue(ok([])),
      create: vi.fn().mockResolvedValue(
        ok({
          id: "cc-1",
          userId: "user-1",
          name: "dnd",
          description: "test",
          createdAt: new Date("2026-05-09T12:00:00Z"),
        }),
      ),
      delete: vi.fn().mockResolvedValue(ok(undefined)),
    },
    models: {
      list: vi.fn().mockResolvedValue([]),
    },
    repos: {
      list: vi.fn().mockResolvedValue(ok([])),
      add: vi.fn().mockResolvedValue(
        ok({
          id: "repo-1",
          name: "cogmo",
          localPath: "/repos/cogmo",
          defaultBranch: "main",
          remoteUrl: "git@github.com:user/cogmo.git",
          verifyCommand: "true",
        }),
      ),
      cloneAndAdd: vi.fn().mockResolvedValue(
        ok({
          id: "repo-1",
          name: "cogmo",
          localPath: "/repos/cogmo",
          defaultBranch: "main",
          remoteUrl: "git@github.com:user/cogmo.git",
          verifyCommand: "true",
        }),
      ),
      remove: vi.fn().mockResolvedValue(ok(undefined)),
    },
    coding: {
      approvePlan: vi.fn().mockResolvedValue(ok({ taskId: "t-1" })),
      cancelTask: vi.fn().mockResolvedValue(ok({ taskId: "t-1" })),
      respondPermission: vi.fn().mockResolvedValue(ok({ taskId: "t-1" })),
    },
    skills: {
      approveDeploy: vi
        .fn()
        .mockResolvedValue(ok({ pendingId: "p-1", skillName: "echo", gitSha: "abc1234" })),
      denyDeploy: vi.fn().mockResolvedValue(ok({ pendingId: "p-1" })),
      list: vi.fn().mockResolvedValue(ok([])),
      disable: vi.fn().mockResolvedValue(ok({ name: "echo" })),
      enable: vi.fn().mockResolvedValue(ok({ name: "echo", alreadyEnabled: false })),
    },
    mcp: {
      toolBudget: vi.fn().mockReturnValue(25),
      addServer: vi.fn().mockResolvedValue(ok({ id: "mcp-1", name: "github" })),
      removeServer: vi.fn().mockResolvedValue(ok(undefined)),
      listServers: vi.fn().mockResolvedValue(ok([])),
      approveServer: vi.fn().mockResolvedValue(ok(undefined)),
      approveTool: vi.fn().mockResolvedValue(ok(undefined)),
      rejectTool: vi.fn().mockResolvedValue(ok(undefined)),
    },
    ...overrides,
  };
}

export function mockAdapter(overrides?: Partial<Adapter>): Adapter {
  return {
    deliver: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function mockMemoryProvider(overrides?: Partial<MemoryProvider>): MemoryProvider {
  return {
    name: "mock",
    retain: vi.fn().mockResolvedValue(undefined),
    retainBatch: vi.fn().mockResolvedValue(undefined),
    recall: vi.fn().mockResolvedValue({ memories: [] }),
    reflect: vi.fn().mockResolvedValue({ answer: "" }),
    ...overrides,
  };
}

export function mockToolRegistry(): ToolRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockReturnValue(undefined),
    definitions: vi.fn().mockReturnValue([]),
    snapshot: vi.fn().mockReturnValue([]),
  } as unknown as ToolRegistry;
}

export function mockStep() {
  return {
    run: vi.fn((_id: string, fn: () => unknown) => fn()),
    sendEvent: vi.fn(),
  };
}

export function mockProvider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    name: "mock",
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "mock response" }],
      stopReason: "end_turn",
      model: "mock-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
    chatStream() {
      throw new Error("chatStream not implemented in mock");
    },
    countTokens: vi.fn().mockResolvedValue(100),
    ...overrides,
  };
}

/**
 * Convenience wrapper for `HandleMessageDeps.resolveProvider` /
 * `ObserverDeps.resolveProvider` injection. Two shapes:
 *
 * - `mockResolver()` / `mockResolver(provider)` — returns the same
 *   provider for **every** model. Fine for tests that don't differentiate
 *   by model. Reaching for this in a test that depends on per-model
 *   dispatch will silently pass against a wrong-routing implementation —
 *   use the map form below for those.
 * - `mockResolver(new Map([[model, provider], ...]))` — per-model
 *   dispatch. Throws on unknown models so a wrong `resolveProvider(model)`
 *   call surfaces as a test failure rather than a silent mismatch.
 */
export function mockResolver(
  arg?: LlmProvider | ReadonlyMap<string, LlmProvider>,
): LlmProviderResolver {
  if (isReadonlyMap(arg)) {
    return (model) => {
      const provider = arg.get(model);
      if (!provider) {
        return Promise.reject(new Error(`mockResolver: no provider configured for "${model}"`));
      }
      // Mock: no row override; the resolver layer falls through to LiteLLM
      // / default. Tests that need explicit limits should override at the
      // resolveLimits layer or use `constantResolver(provider, { ... })`.
      return Promise.resolve({
        provider,
        limits: { contextWindow: null, maxOutputTokens: null },
      });
    };
  }
  return constantResolver(arg ?? mockProvider());
}

// `ReadonlyMap` is a structural TS-only interface, so `instanceof Map`
// doesn't narrow `LlmProvider | ReadonlyMap<...>` directly. Wrap the
// runtime check in a type predicate that asserts the read-only view —
// callers keep their immutable contract, the implementation gets the
// narrowed type for free.
function isReadonlyMap<K, V>(x: unknown): x is ReadonlyMap<K, V> {
  return x instanceof Map;
}

export function mockStreamHandle(overrides?: Partial<StreamHandle>): StreamHandle {
  return {
    push: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function mockStreamingAdapter(overrides?: Partial<StreamingAdapter>): StreamingAdapter {
  return {
    stop: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn().mockResolvedValue(mockStreamHandle()),
    ...overrides,
  };
}

export function mockDeliveryHandle(overrides?: Partial<DeliveryHandle>): DeliveryHandle {
  return {
    push: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    hasBatchTargets: vi.fn().mockReturnValue(true),
    deliverBatch: vi.fn().mockResolvedValue(undefined),
    canDeliverVoice: vi.fn().mockReturnValue(false),
    deliverVoice: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function mockDeliveryRouter(overrides?: Partial<DeliveryRouter>): DeliveryRouter {
  return {
    prepare: vi.fn().mockResolvedValue(mockDeliveryHandle()),
    notifyConversation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function mockAttachmentStore(overrides?: Partial<AttachmentStore>): AttachmentStore {
  return {
    upload: vi.fn().mockResolvedValue("inbound/test.jpg"),
    download: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3])),
    ...overrides,
  };
}

export function mockSecretsStore(overrides?: Partial<SecretsStore>): SecretsStore {
  return {
    putSecret: vi.fn().mockResolvedValue({ id: "secret-1" }),
    getSecret: vi.fn().mockResolvedValue(null),
    getSecretById: vi.fn().mockResolvedValue(null),
    getSecretMeta: vi.fn().mockResolvedValue(null),
    listSecrets: vi.fn().mockResolvedValue([]),
    markValidated: vi.fn().mockResolvedValue(undefined),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    deleteAllSecrets: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Spy on Inngest's private `_send` method so `step.sendEvent` inside a
 * function under test doesn't reach a real Inngest dev server (which
 * would burn ~2s per test on ECONNREFUSED retry).
 *
 * The cast is the minimum-overhead workaround:
 *   - `declare module "inngest"` augmentation fails — the SDK declares
 *     `_send` internally as private, TS rejects with "Duplicate
 *     identifier";
 *   - `vi.mock("../../inngest/client.js")` is heavy and brittle to
 *     SDK internals;
 *   - skipping the spy entirely hangs the function under test.
 *
 * Returns the MockInstance so callers can chain `.mockResolvedValue` /
 * `.toHaveBeenCalledWith` etc. The cast is contained here — call-sites
 * have no `as` of any kind.
 */
export function spyOnInngestSend(client: Inngest) {
  type InngestSendShape = { _send(args: unknown): Promise<{ ids: string[] }> };
  return vi.spyOn(client as unknown as InngestSendShape, "_send");
}
