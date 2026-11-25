import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../db/index.js";
import { inboundArrived } from "../inngest/events.js";
import { logger } from "../logger.js";
import {
  mockAgentStore,
  mockAttachmentStore,
  mockInngest,
  mockSecretsStore,
  mockTransportStore,
} from "../test/factories.js";
import { resolveCredentialSecrets, startChannels } from "./registry.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("startChannels", () => {
  it("reports a row whose type this build has no adapter for, and starts nothing for it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const transportStore = mockTransportStore({
        getAllChannels: vi
          .fn()
          .mockResolvedValue([
            { id: "dc-1", type: "discord", credentials: {}, identityMode: "fixed" },
          ]),
      });

      const result = await startChannels({
        defaultUserId: "user-1",
        defaultProfileId: "profile-1",
        runInTx: fakeRunInTx,
        transportStore,
        agentStore: mockAgentStore(),
        inngest: mockInngest(),
        inboundArrived,
        attachments: mockAttachmentStore(),
        idleTimeoutMs: 60_000,
        boundary: { promptTimeoutMs: 60_000, minUserTurns: 1 },
        secretsStore: mockSecretsStore(),
      });

      expect(result.unsupported).toEqual([{ channelType: "discord", channelId: "dc-1" }]);
      expect(result.adapters).toEqual([]);
      expect(result.adapterMap.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        { type: "discord", channelId: "dc-1" },
        "unknown channel type",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

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
