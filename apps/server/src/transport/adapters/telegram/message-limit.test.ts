import { describe, expect, it } from "vitest";
import { fitTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "./message-limit.js";

describe("fitTelegramMessage", () => {
  it("leaves a message at the cap unchanged", () => {
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(fitTelegramMessage(text)).toBe(text);
  });

  it("does not cut an emoji in half at the boundary", () => {
    const text = `${"x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 2)}😀😀`;
    const fitted = fitTelegramMessage(text);
    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect([...fitted].every((ch) => !/[\ud800-\udfff]/.test(ch))).toBe(true);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("cuts a longer message to the cap, ending in an ellipsis", () => {
    const fitted = fitTelegramMessage("x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 1));
    expect(fitted).toHaveLength(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(fitted.endsWith("…")).toBe(true);
  });
});
