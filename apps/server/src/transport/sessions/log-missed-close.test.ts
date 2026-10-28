import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { logMissedClose } from "./log-missed-close.js";

describe("logMissedClose", () => {
  it("logs nothing for a close that landed", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      logMissedClose({ sessionId: "s1" }, { kind: "closed" });
      expect(debug).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });

  it("logs what the close found, with the caller's fields", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    try {
      logMissedClose({ sessionId: "s1" }, { kind: "stale", status: "closed" });
      expect(debug).toHaveBeenCalledWith(
        { sessionId: "s1", kind: "stale", status: "closed" },
        "session was already closed",
      );
      logMissedClose({ sessionId: "s2" }, { kind: "not_found" });
      expect(debug).toHaveBeenCalledWith(
        { sessionId: "s2", kind: "not_found" },
        "session was already closed",
      );
    } finally {
      debug.mockRestore();
    }
  });
});
