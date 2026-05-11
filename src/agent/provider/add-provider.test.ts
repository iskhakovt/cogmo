import { describe, expect, it, vi } from "vitest";
import type { SecretsStore } from "../../secrets/store/index.js";
import type { AgentStore } from "../store/index.js";
import { addProvider } from "./add-provider.js";

const FAKE_TX = { __mockTx: true } as never;

vi.mock("../../setup/validate.js", () => ({
  validateAnthropicKey: vi.fn().mockResolvedValue({ valid: true }),
  validateOpenAICompatibleKey: vi.fn().mockResolvedValue({ valid: true }),
}));

interface StubSetup {
  putSecret?: ReturnType<typeof vi.fn>;
  markValidated?: ReturnType<typeof vi.fn>;
  createProvider?: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: StubSetup = {}) {
  const putSecret = opts.putSecret ?? vi.fn().mockResolvedValue({ id: "secret-1" });
  const markValidated = opts.markValidated ?? vi.fn().mockResolvedValue(undefined);
  const createProvider = opts.createProvider ?? vi.fn().mockResolvedValue({ id: "provider-1" });

  const secretsStore = { putSecret, markValidated } as unknown as SecretsStore;
  const agentStore = { createProvider } as unknown as AgentStore;

  // runInTx invokes its callback synchronously with the fake tx — the
  // assertion that everything runs under one tx hinges on tracking how
  // many times runInTx itself is called.
  const runInTx = vi.fn().mockImplementation((cb) => cb(FAKE_TX));

  return { agentStore, secretsStore, runInTx, putSecret, markValidated, createProvider };
}

describe("addProvider — transaction atomicity", () => {
  it("runs putSecret + markValidated + createProvider inside a single transaction", async () => {
    const deps = makeDeps();
    await addProvider(deps, {
      name: "anthropic",
      type: "anthropic",
      apiKey: "sk-ant-test-1234567890",
    });
    // One runInTx wraps all three store writes — otherwise the bot's
    // concern fires: a failing createProvider would leave the secret
    // orphaned with no provider pointer.
    expect(deps.runInTx).toHaveBeenCalledTimes(1);
    expect(deps.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "anthropic_api_key" }),
    );
    expect(deps.markValidated).toHaveBeenCalledWith(FAKE_TX, "anthropic_api_key");
    expect(deps.createProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        name: "anthropic",
        type: "anthropic",
        secretId: "secret-1",
      }),
    );
  });

  it("rolls back the secret write when createProvider throws", async () => {
    // The runInTx fake propagates the rejection; in production a
    // PostgreSQL UNIQUE violation on llm_providers.name would roll back
    // the whole transaction including the secret insert.
    const createProvider = vi.fn().mockRejectedValue(new Error("duplicate key"));
    const deps = makeDeps({ createProvider });

    await expect(
      addProvider(deps, {
        name: "anthropic",
        type: "anthropic",
        apiKey: "sk-ant-test-1234567890",
      }),
    ).rejects.toThrow(/duplicate key/);

    // Both writes attempted, but a real DB would discard both via the tx
    // rollback. Our fake doesn't simulate rollback; the structural
    // guarantee is "everything ran under the same runInTx callback".
    expect(deps.runInTx).toHaveBeenCalledTimes(1);
  });

  it("skips markValidated when the live key validation fails", async () => {
    const { validateAnthropicKey } = await import("../../setup/validate.js");
    vi.mocked(validateAnthropicKey).mockResolvedValueOnce({
      valid: false,
      error: "Invalid API key",
    });
    const deps = makeDeps();
    const result = await addProvider(deps, {
      name: "anthropic",
      type: "anthropic",
      apiKey: "sk-ant-bad-1234567890",
    });
    expect(result.validation.valid).toBe(false);
    expect(deps.markValidated).not.toHaveBeenCalled();
    // putSecret + createProvider still run — the wizard prompts "save
    // anyway?" semantics live at the caller, not in this domain function.
    expect(deps.putSecret).toHaveBeenCalled();
    expect(deps.createProvider).toHaveBeenCalled();
  });
});
