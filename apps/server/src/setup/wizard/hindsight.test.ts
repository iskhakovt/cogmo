import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetClackPrompts } from "../../test/wizard.js";
import { stepValidateHindsight } from "./hindsight.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const { validateHindsightSpy } = vi.hoisted(() => ({
  validateHindsightSpy: vi.fn(),
}));

vi.mock("../validate.js", () => ({
  validateHindsight: validateHindsightSpy,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
  validateHindsightSpy.mockReset();
});

describe("stepValidateHindsight", () => {
  it("logs reachable when probe succeeds", async () => {
    validateHindsightSpy.mockResolvedValueOnce({ valid: true });

    await stepValidateHindsight();

    expect(validateHindsightSpy).toHaveBeenCalledOnce();
    expect(vi.mocked(p.log.warn)).not.toHaveBeenCalled();
  });

  it("warns when probe fails", async () => {
    validateHindsightSpy.mockResolvedValueOnce({ valid: false, error: "ECONNREFUSED" });

    await stepValidateHindsight();

    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringMatching(/Memory features will not work/),
    );
  });
});
