/**
 * Shared mock factories for unit tests.
 * Every store interface method is mocked — tests override what they need.
 */
import { ok } from "neverthrow";
import { vi } from "vitest";
import type { AgentStore } from "../agent/store/index.js";
import type { ToolRegistry } from "../agent/tools.js";
import type { MemoryProvider } from "../memory/provider.js";
import type { TransportStore } from "../transport/store/index.js";
import type { Transport } from "../transport/transport.js";
import type { Adapter } from "../transport/types.js";

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
    getLastAssistantMessage: vi.fn().mockResolvedValue(null),
    getHistory: vi.fn().mockResolvedValue([]),
    getProfile: vi.fn().mockResolvedValue({
      id: "profile-1",
      basePrompt: "test",
      model: "test-model",
      toolSet: [],
    }),
    getDefaultProfile: vi.fn().mockResolvedValue({ id: "profile-1" }),
    createProfile: vi.fn().mockResolvedValue({ id: "profile-1" }),
    getActiveRules: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue({ id: "msg-1", role: "assistant", content: "test" }),
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
    resolveUser: vi.fn().mockResolvedValue(null),
    createWildcardIdentity: vi.fn().mockResolvedValue({ id: "identity-1" }),
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
