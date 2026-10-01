/** Context and transport stubs shared by the command handlers' tests. */

import { vi } from "vitest";
import { type DeepPartial, mockTransportDeep } from "../../../../test/factories.js";
import type { Transport } from "../../../transport.js";
import type { TelegramCommandContext } from "./reply.js";

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
