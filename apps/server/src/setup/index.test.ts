import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMasterKey } from "../secrets/encryption.js";
import { expectDefined } from "../test/assertions.js";
import { parseNonInteractiveEnv } from "./env.js";
import { runSetup } from "./index.js";
import { migrateAndSeed } from "./migrate-and-seed.js";
import {
  NonInteractiveValidationError,
  persistNonInteractive,
  type ValidatedNonInteractive,
  validateNonInteractive,
} from "./non-interactive.js";
import { runWizard } from "./wizard.js";

vi.mock("./migrate-and-seed.js", () => ({ migrateAndSeed: vi.fn() }));
vi.mock("./non-interactive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./non-interactive.js")>()),
  validateNonInteractive: vi.fn(),
  persistNonInteractive: vi.fn(),
}));
vi.mock("./wizard.js", () => ({
  runWizard: vi.fn(),
  WizardCancelled: class WizardCancelled extends Error {},
}));

const VALIDATED: ValidatedNonInteractive = {
  answers: parseNonInteractiveEnv({
    COGMO_LLM_PROVIDER_TYPE: "anthropic",
    COGMO_LLM_API_KEY: "sk-ant-test-key-abc123xyz",
  })._unsafeUnwrap(),
};

beforeEach(() => {
  vi.stubEnv("COGMO_MASTER_KEY", generateMasterKey());
  // Never connected: every database step below is mocked.
  vi.stubEnv("DATABASE_URL", "postgres://cogmo@127.0.0.1:1/cogmo");
  vi.mocked(migrateAndSeed).mockResolvedValue({ userId: "user-1", profileId: "profile-1" });
  vi.mocked(validateNonInteractive).mockResolvedValue(ok(VALIDATED));
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("runSetup", () => {
  it("non-interactive: validates, migrates and seeds with the reset, then persists for the seeded user", async () => {
    await runSetup({ nonInteractive: true, reset: "channels" });

    expect(migrateAndSeed).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrapLock: expect.any(Function) }),
      { reset: "channels" },
    );
    expect(persistNonInteractive).toHaveBeenCalledWith(expect.anything(), VALIDATED, "user-1");
    const [validated] = vi.mocked(validateNonInteractive).mock.invocationCallOrder;
    const [seeded] = vi.mocked(migrateAndSeed).mock.invocationCallOrder;
    const [persisted] = vi.mocked(persistNonInteractive).mock.invocationCallOrder;
    expect(expectDefined(validated, "validate")).toBeLessThan(expectDefined(seeded, "seed"));
    expect(expectDefined(seeded, "seed")).toBeLessThan(expectDefined(persisted, "persist"));
    expect(runWizard).not.toHaveBeenCalled();
  });

  it("interactive: migrates and seeds, then runs the wizard for the seeded user", async () => {
    await runSetup({});

    expect(validateNonInteractive).not.toHaveBeenCalled();
    expect(migrateAndSeed).toHaveBeenCalledWith(expect.anything(), { reset: null });
    expect(runWizard).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", bootstrapLock: expect.any(Function) }),
    );
    expect(persistNonInteractive).not.toHaveBeenCalled();
  });

  it("non-interactive: invalid input fails before migrating or resetting", async () => {
    vi.mocked(validateNonInteractive).mockResolvedValue(
      err(new NonInteractiveValidationError(["LLM provider (anthropic): Invalid API key"])),
    );
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runSetup({ nonInteractive: true, reset: "all" });
    printed.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(migrateAndSeed).not.toHaveBeenCalled();
    expect(persistNonInteractive).not.toHaveBeenCalled();
  });
});
