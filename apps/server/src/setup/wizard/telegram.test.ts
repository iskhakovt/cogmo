import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClackValidate } from "../../test/assertions.js";
import { buildWizardDeps, FAKE_TX, resetClackPrompts } from "../../test/wizard.js";
import { stepConfigureTelegram } from "./telegram.js";

vi.mock("@clack/prompts", async () =>
  (await import("../../test/clack-prompts-mock.js")).clackPromptsMock(),
);

const { validateTelegramTokenSpy } = vi.hoisted(() => ({
  validateTelegramTokenSpy: vi.fn(),
}));

vi.mock("../validate.js", () => ({
  validateTelegramToken: validateTelegramTokenSpy,
}));

vi.mock("../seed.js", () => ({
  seedChannelRules: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetClackPrompts();
  validateTelegramTokenSpy.mockReset();
});

describe("stepConfigureTelegram", () => {
  it("keeps existing channel when 'keep' is selected and seeds channel rules", async () => {
    const deps = buildWizardDeps();
    deps.transportStore.getChannelByType.mockResolvedValue({
      id: "ch-1",
      type: "telegram",
    } as never);
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    const result = await stepConfigureTelegram(deps, "u-1");

    expect(result).toEqual({});
    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(deps.transportStore.removeChannel).not.toHaveBeenCalled();
  });

  it("skips entirely when no channel exists AND user declines", async () => {
    const deps = buildWizardDeps();
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    const result = await stepConfigureTelegram(deps, "u-1");

    expect(result).toEqual({});
    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: validates token, creates channel + identity rows for each allowlisted user", async () => {
    const deps = buildWizardDeps();
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    deps.transportStore.createChannel.mockResolvedValue({ id: "ch-new" });
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // add channel
    vi.mocked(p.password).mockResolvedValueOnce("123:ABCdef");
    validateTelegramTokenSpy.mockResolvedValueOnce({
      valid: true,
      meta: { botUsername: "cogmo_test_bot" },
    });
    vi.mocked(p.text).mockResolvedValueOnce("111, 222 ,333");

    const result = await stepConfigureTelegram(deps, "u-1");

    expect(result).toEqual({ botUsername: "cogmo_test_bot" });
    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "telegram_bot_token" }),
    );
    expect(deps.transportStore.createChannel).toHaveBeenCalledWith(FAKE_TX, {
      type: "telegram",
      credentials: { tokenSecretName: "telegram_bot_token" },
      identityMode: "mapped",
    });
    expect(deps.transportStore.createIdentity).toHaveBeenCalledTimes(3);
  });

  it("bails out gracefully when token validation fails — no channel row created", async () => {
    const deps = buildWizardDeps();
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("123:ABC");
    validateTelegramTokenSpy.mockResolvedValueOnce({ valid: false, error: "401 Unauthorized" });

    const result = await stepConfigureTelegram(deps, "u-1");

    expect(result).toEqual({});
    expect(deps.transportStore.createChannel).not.toHaveBeenCalled();
    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("replaces an existing channel when 'replace' is selected, then prompts for new token", async () => {
    const deps = buildWizardDeps();
    deps.transportStore.getChannelByType.mockResolvedValue({
      id: "ch-old",
      type: "telegram",
    } as never);
    deps.transportStore.createChannel.mockResolvedValue({ id: "ch-new" });
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    vi.mocked(p.password).mockResolvedValueOnce("999:NEW");
    validateTelegramTokenSpy.mockResolvedValueOnce({
      valid: true,
      meta: { botUsername: "new_bot" },
    });
    vi.mocked(p.text).mockResolvedValueOnce("42");

    const result = await stepConfigureTelegram(deps, "u-1");

    expect(result).toEqual({ botUsername: "new_bot" });
    expect(deps.transportStore.removeChannel).toHaveBeenCalledWith(FAKE_TX, "ch-old");
    expect(deps.transportStore.createChannel).toHaveBeenCalled();
  });

  it("validates the bot-token format: rejects strings without a colon", async () => {
    const deps = buildWizardDeps();
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    deps.transportStore.createChannel.mockResolvedValue({ id: "ch" });
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("123:ABC");
    validateTelegramTokenSpy.mockResolvedValueOnce({
      valid: true,
      meta: { botUsername: "test" },
    });
    vi.mocked(p.text).mockResolvedValueOnce("42");

    await stepConfigureTelegram(deps, "u-1");

    const passCall = vi.mocked(p.password).mock.calls[0]?.[0];
    expect(runClackValidate(passCall?.validate, "nocolon")).toMatch(/colon/);
    expect(runClackValidate(passCall?.validate, "123:ABC")).toBeUndefined();
  });

  it("validates allowlist format: rejects non-numeric IDs", async () => {
    const deps = buildWizardDeps();
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    deps.transportStore.createChannel.mockResolvedValue({ id: "ch" });
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("123:ABC");
    validateTelegramTokenSpy.mockResolvedValueOnce({
      valid: true,
      meta: { botUsername: "x" },
    });
    vi.mocked(p.text).mockResolvedValueOnce("42");

    await stepConfigureTelegram(deps, "u-1");

    const textCall = vi.mocked(p.text).mock.calls[0]?.[0];
    expect(runClackValidate(textCall?.validate, "")).toMatch(/required/);
    expect(runClackValidate(textCall?.validate, "abc,42")).toMatch(/not a valid numeric/);
    expect(runClackValidate(textCall?.validate, "42, 99")).toBeUndefined();
  });
});
