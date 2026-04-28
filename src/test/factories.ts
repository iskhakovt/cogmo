/**
 * Shared mock factories for unit tests.
 * Every store interface method is mocked — tests override what they need.
 */
import { ok } from "neverthrow";
import { vi } from "vitest";
import type { AgentStore } from "../agent/store/index.js";
import type { ToolRegistry } from "../agent/tools.js";
import type { LlmProvider } from "../llm/provider.js";
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
    }),
    insertMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    insertMessages: vi.fn().mockResolvedValue({ id: "msg-1" }),
    getLastAssistantMessage: vi.fn().mockResolvedValue(null),
    getHistory: vi.fn().mockResolvedValue([]),
    getProfile: vi.fn().mockResolvedValue({
      id: "profile-1",
      userId: null,
      name: "assistant",
      basePrompt: "test",
      model: "claude-sonnet-4-20250514",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      toolSet: [],
    }),
    getDefaultProfile: vi.fn().mockResolvedValue({ id: "profile-1" }),
    createProfile: vi.fn().mockResolvedValue({
      id: "profile-1",
      userId: null,
      name: "assistant",
      basePrompt: "",
      model: "claude-sonnet-4-20250514",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      toolSet: [],
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
    resolveProviderForModel: vi.fn().mockResolvedValue(null),
    listProvidersForModel: vi.fn().mockResolvedValue([]),
    getNextModelProviderPosition: vi.fn().mockResolvedValue(0),
    removeModelProvidersByProvider: vi.fn().mockResolvedValue(undefined),
    hasChannelRules: vi.fn().mockResolvedValue(false),
    insertManualRule: vi.fn().mockResolvedValue({ id: "rule-1" }),
    getCorrections: vi.fn().mockResolvedValue([]),
    upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: false }),
    countActiveRules: vi.fn().mockResolvedValue(0),
    replaceRules: vi.fn().mockResolvedValue({ id: "rule-1" }),
    // --- Admin (Chunk 3) ---
    listProfiles: vi.fn().mockResolvedValue([]),
    getProfileOwner: vi.fn().mockResolvedValue(null),
    updateProfile: vi.fn().mockResolvedValue({
      id: "profile-1",
      userId: null,
      name: "test",
      basePrompt: "",
      model: "claude-sonnet-4-20250514",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      toolSet: [],
    }),
    countProfileReferences: vi.fn().mockResolvedValue({ conversations: 0, messages: 0 }),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    setConversationProfile: vi.fn().mockResolvedValue(undefined),
    setAlias: vi.fn().mockResolvedValue(undefined),
    findConversationByAlias: vi.fn().mockResolvedValue(null),
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
    getSourceSessions: vi.fn().mockResolvedValue([]),
    getReceiveAllSessions: vi.fn().mockResolvedValue([]),
    resolveUser: vi.fn().mockResolvedValue({ userId: "user-1" }),
    createWildcardIdentity: vi.fn().mockResolvedValue({ id: "identity-1" }),
    createIdentity: vi.fn().mockResolvedValue({ id: "identity-1" }),
    updateChannelCredentials: vi.fn().mockResolvedValue(undefined),
    removeChannel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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
      setAlias: vi.fn().mockResolvedValue(ok(undefined)),
      setProfile: vi.fn().mockResolvedValue(ok(undefined)),
    },
    profiles: {
      list: vi.fn().mockResolvedValue(ok([])),
      create: vi.fn().mockResolvedValue(
        ok({
          id: "profile-new",
          userId: "user-1",
          name: "test",
          basePrompt: "",
          model: "claude-sonnet-4-20250514",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          toolSet: [],
        }),
      ),
      update: vi.fn().mockResolvedValue(
        ok({
          id: "profile-1",
          userId: "user-1",
          name: "test",
          basePrompt: "",
          model: "claude-sonnet-4-20250514",
          summarizationModel: null,
          extractionModel: null,
          autoRecall: "heuristic",
          toolSet: [],
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
    ...overrides,
  };
}

export function mockDeliveryRouter(overrides?: Partial<DeliveryRouter>): DeliveryRouter {
  return {
    prepare: vi.fn().mockResolvedValue(mockDeliveryHandle()),
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
