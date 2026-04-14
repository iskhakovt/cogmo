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
      basePrompt: "test",
      model: "claude-sonnet-4-20250514",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      toolSet: [],
    }),
    getDefaultProfile: vi.fn().mockResolvedValue({ id: "profile-1" }),
    createProfile: vi.fn().mockResolvedValue({ id: "profile-1" }),
    getActiveRules: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue({ id: "msg-1", role: "assistant", content: "test" }),
    getCoreMemoryBlocks: vi.fn().mockResolvedValue([]),
    upsertCoreMemoryBlock: vi.fn().mockResolvedValue(undefined),
    getLastMessageTime: vi.fn().mockResolvedValue(null),
    getLastInputTokens: vi.fn().mockResolvedValue(null),
    createProvider: vi.fn().mockResolvedValue({ id: "provider-1" }),
    getProvider: vi.fn().mockResolvedValue(null),
    listProviders: vi.fn().mockResolvedValue([]),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    addModelProvider: vi.fn().mockResolvedValue({ id: "mp-1" }),
    resolveProviderForModel: vi.fn().mockResolvedValue(null),
    getNextModelProviderPosition: vi.fn().mockResolvedValue(0),
    removeModelProvidersByProvider: vi.fn().mockResolvedValue(undefined),
    hasChannelRules: vi.fn().mockResolvedValue(false),
    insertManualRule: vi.fn().mockResolvedValue({ id: "rule-1" }),
    getCorrections: vi.fn().mockResolvedValue([]),
    upsertCorrection: vi.fn().mockResolvedValue({ id: "rule-1", promoted: false }),
    countActiveRules: vi.fn().mockResolvedValue(0),
    replaceRules: vi.fn().mockResolvedValue({ id: "rule-1" }),
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
    emit: vi.fn().mockResolvedValue(ok(undefined)),
    uploadAttachment: vi.fn().mockResolvedValue("inbound/test.jpg"),
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
