import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../db/index.js";
import { mockSecretsStore } from "../test/factories.js";
import { resolveCredentialSecrets } from "./registry.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("resolveCredentialSecrets", () => {
  it("resolves SecretName fields to their plaintext values", async () => {
    const store = mockSecretsStore({
      getSecret: vi.fn().mockResolvedValue("actual-token-value"),
    });

    const result = await resolveCredentialSecrets(
      { tokenSecretName: "telegram_bot_token", apiRoot: "https://custom.api" },
      store,
      fakeRunInTx,
    );

    expect(result).toEqual({ token: "actual-token-value", apiRoot: "https://custom.api" });
    expect(store.getSecret).toHaveBeenCalledWith(expect.anything(), "telegram_bot_token");
  });

  it("throws when a referenced secret is not found", async () => {
    const store = mockSecretsStore({
      getSecret: vi.fn().mockResolvedValue(null),
    });

    await expect(
      resolveCredentialSecrets({ tokenSecretName: "missing_secret" }, store, fakeRunInTx),
    ).rejects.toThrow(/secret "missing_secret" but it was not found/);
  });

  it("passes through non-object credentials unchanged", async () => {
    const store = mockSecretsStore();
    expect(await resolveCredentialSecrets("plain-string", store, fakeRunInTx)).toBe("plain-string");
    expect(await resolveCredentialSecrets(null, store, fakeRunInTx)).toBeNull();
    expect(await resolveCredentialSecrets(42, store, fakeRunInTx)).toBe(42);
  });

  it("passes through credentials with no SecretName fields unchanged", async () => {
    const store = mockSecretsStore();
    const creds = { token: "raw-value", apiRoot: "https://api" };
    const result = await resolveCredentialSecrets(creds, store, fakeRunInTx);
    expect(result).toEqual(creds);
    expect(store.getSecret).not.toHaveBeenCalled();
  });

  it("handles empty object", async () => {
    const store = mockSecretsStore();
    expect(await resolveCredentialSecrets({}, store, fakeRunInTx)).toEqual({});
  });
});
