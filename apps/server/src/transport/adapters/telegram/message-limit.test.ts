import { describe, expect, it } from "vitest";
import {
  fitTelegramMessage,
  fitTelegramToast,
  packTelegramMessages,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "./message-limit.js";

describe("fitTelegramMessage", () => {
  it("leaves a message at the cap unchanged", () => {
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(fitTelegramMessage(text)).toBe(text);
  });

  it("does not cut an emoji in half at the boundary", () => {
    const text = `${"x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH - 2)}😀😀`;
    const fitted = fitTelegramMessage(text);
    expect(fitted.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(fitted.isWellFormed()).toBe(true);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("cuts a longer message to the cap, ending in an ellipsis", () => {
    const fitted = fitTelegramMessage("x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 1));
    expect(fitted).toHaveLength(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(fitted.endsWith("…")).toBe(true);
  });
});

describe("fitTelegramToast", () => {
  it("leaves a toast at Telegram's 200-character cap unchanged", () => {
    const text = "x".repeat(200);
    expect(fitTelegramToast(text)).toBe(text);
  });

  it("cuts a longer toast to the cap, ending in an ellipsis", () => {
    const fitted = fitTelegramToast("x".repeat(201));
    expect(fitted).toHaveLength(200);
    expect(fitted.endsWith("…")).toBe(true);
  });
});

describe("packTelegramMessages", () => {
  it("keeps lines that fit in one message", () => {
    expect(packTelegramMessages(["Skills:", "a", "b"])).toEqual(["Skills:\na\nb"]);
  });

  it("splits only between lines, never inside one", () => {
    const line = "x".repeat(1500);
    const parts = packTelegramMessages(["Skills:", line, line, line]);
    expect(parts).toEqual([`Skills:\n${line}\n${line}`, line]);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
  });

  it("fits a single line over the cap on its own", () => {
    const parts = packTelegramMessages(["short", "y".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 10)]);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toHaveLength(TELEGRAM_MAX_MESSAGE_LENGTH);
  });
});
