import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { logMissedClose } from "./log-missed-close.js";

describe("logMissedClose", () => {
  it("logs nothing and reports false for a close that landed", () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    try {
      expect(logMissedClose("info", { sessionId: "s1" }, { kind: "closed" })).toBe(false);
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });

  it("logs what the close found, at the caller's level, and reports true", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      expect(logMissedClose("warn", { sessionId: "s1" }, { kind: "stale", status: "closed" })).toBe(
        true,
      );
      expect(warn).toHaveBeenCalledWith(
        { sessionId: "s1", kind: "stale", status: "closed" },
        "session was already closed",
      );
      expect(logMissedClose("debug", { sessionId: "s2" }, { kind: "not_found" })).toBe(true);
      expect(debug).toHaveBeenCalledWith(
        { sessionId: "s2", kind: "not_found" },
        "session was already closed",
      );
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });
});
