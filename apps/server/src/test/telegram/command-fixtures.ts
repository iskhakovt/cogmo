/** Context and transport stubs shared by the command handlers' tests. */

import { vi } from "vitest";
import type { TelegramCommandContext } from "../../transport/adapters/telegram/commands/reply.js";
import type { Transport } from "../../transport/transport.js";
import { type DeepPartial, mockTransportDeep } from "../factories.js";

export function mkCtx(match?: string): TelegramCommandContext & {
  reply: ReturnType<typeof vi.fn>;
} {
  return {
    chat: { id: 42 },
    from: { id: 1 },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

export function transportWith(overrides: DeepPartial<Transport> = {}): Transport {
  return mockTransportDeep(overrides);
}
