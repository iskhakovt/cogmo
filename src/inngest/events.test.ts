import { describe, expect, it } from "vitest";
import { inboundArrived, responseReady } from "./events.js";

describe("inboundArrived", () => {
  it("creates a valid event", () => {
    const event = inboundArrived.create({
      conversationId: "conv-1",
      inboundMessageId: "inbound-1",
    });

    expect(event.name).toBe("inbound/arrived");
    expect(event.data.conversationId).toBe("conv-1");
    expect(event.data.inboundMessageId).toBe("inbound-1");
  });
});

describe("responseReady", () => {
  it("creates a valid event", () => {
    const event = responseReady.create({
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    expect(event.name).toBe("response/ready");
    expect(event.data.messageId).toBe("msg-1");
  });
});
