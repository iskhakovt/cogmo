import { describe, expect, it } from "vitest";
import { messageReceived, messageResponse } from "./events.js";

describe("messageReceived", () => {
  it("creates a valid event", () => {
    const event = messageReceived.create({
      channel: "cli",
      chatId: "chat-1",
      userId: "user-1",
      text: "hello",
    });

    expect(event.name).toBe("message/received");
    expect(event.data.channel).toBe("cli");
    expect(event.data.text).toBe("hello");
  });
});

describe("messageResponse", () => {
  it("creates a valid event", () => {
    const event = messageResponse.create({
      conversationId: "conv-1",
      channel: "cli",
      chatId: "chat-1",
      text: "hi there",
    });

    expect(event.name).toBe("message/response");
    expect(event.data.text).toBe("hi there");
  });
});
