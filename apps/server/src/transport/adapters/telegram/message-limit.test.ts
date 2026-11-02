import { describe, expect, it } from "vitest";
import { fitTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "./message-limit.js";

describe("fitTelegramMessage", () => {
  it("leaves a message at the cap unchanged", () => {
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(fitTelegramMessage(text)).toBe(text);
  });

  it("cuts a longer message to the cap, ending in an ellipsis", () => {
    const fitted = fitTelegramMessage("x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 1));
    expect(fitted).toHaveLength(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(fitted.endsWith("…")).toBe(true);
  });
});
