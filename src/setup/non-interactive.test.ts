/**
 * Unit tests for non-interactive setup.
 *
 * PGlite for the DB, injected validators for LLM/Telegram HTTP — no network,
 * no module mocks. Each test reflects one boundary behavior.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DrizzleAgentStore } from "../agent/store/index.js";
import { llmProviders, modelProviders } from "../agent/store/schema.js";
import type { Database } from "../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { secrets as secretsTable } from "../secrets/store/schema.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { channels, userIdentities as userIdentitiesTable } from "../transport/store/schema.js";
import { parseNonInteractiveEnv, SetupEnvError } from "./env.js";
import {
  NonInteractiveValidationError,
  runNonInteractive,
  type Validators,
} from "./non-interactive.js";
import type { ValidationResult } from "./validate.js";

let db: Database;
let close: () => Promise<void>;
let agentStore: DrizzleAgentStore;
let transportStore: DrizzleTransportStore;
let secretsStore: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  agentStore = new DrizzleAgentStore(db);
  transportStore = new DrizzleTransportStore(db);
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(db, key);
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

// --- helpers ---

function validators(overrides?: Partial<Validators>): Validators {
  const okResult: ValidationResult = { valid: true };
  return {
    llmAnthropic: vi.fn().mockResolvedValue(okResult),
    llmOpenAICompatible: vi.fn().mockResolvedValue(okResult),
    telegram: vi.fn().mockResolvedValue({ valid: true, meta: { botUsername: "cogmo_test_bot" } }),
    tavily: vi.fn().mockResolvedValue(okResult),
    ...overrides,
  };
}

function baseEnv(overrides?: Record<string, string | undefined>): Record<string, string> {
  // Strip keys set to undefined so `in` checks behave the same as an unset var.
  const defaults = {
    COGMO_LLM_PROVIDER_TYPE: "anthropic",
    COGMO_LLM_API_KEY: "sk-ant-test-key-abc123xyz",
    ...overrides,
  };
  return Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined)) as Record<
    string,
    string
  >;
}

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cogmo-ni-test-"));
  const path = join(dir, "secret.txt");
  writeFileSync(path, content);
  return path;
}

async function rowCount(
  db: Database,
  table:
    | typeof llmProviders
    | typeof modelProviders
    | typeof channels
    | typeof userIdentitiesTable
    | typeof secretsTable,
): Promise<number> {
  const rows = await db.select().from(table);
  return rows.length;
}

// --- env parsing ---

describe("parseNonInteractiveEnv", () => {
  it("returns typed answers for a minimal valid env", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
    });
    if (r.isErr()) throw r.error;
    expect(r.value.llmProviderType).toBe("anthropic");
    expect(r.value.llmApiKey).toBe("sk-ant-0123456789");
    expect(r.value.telegramBotToken).toBeUndefined();
  });

  it("reads a secret from the _FILE variant", () => {
    const path = tempFile("sk-ant-from-file-01234");
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY_FILE: path,
    });
    if (r.isErr()) throw r.error;
    expect(r.value.llmApiKey).toBe("sk-ant-from-file-01234");
  });

  it("parses comma-separated Telegram user IDs", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_TELEGRAM_BOT_TOKEN: "123456:ABC-def",
      COGMO_TELEGRAM_ALLOWED_USERS: "100, 200 ,300",
    });
    if (r.isErr()) throw r.error;
    expect(r.value.telegramAllowedUsers).toEqual(["100", "200", "300"]);
  });

  it("fails when required vars are missing", () => {
    const r = parseNonInteractiveEnv({});
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error).toBeInstanceOf(SetupEnvError);
    expect(r.error.issues.join("\n")).toMatch(/COGMO_LLM_PROVIDER_TYPE/);
    expect(r.error.issues.join("\n")).toMatch(/COGMO_LLM_API_KEY/);
  });

  it("rejects unknown provider types", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "bogus",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
    });
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error.issues.join("\n")).toMatch(/COGMO_LLM_PROVIDER_TYPE/);
  });

  it("requires COGMO_LLM_BASE_URL when provider type is custom", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "custom",
      COGMO_LLM_API_KEY: "sk-custom-012345",
    });
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error.issues.join("\n")).toMatch(/COGMO_LLM_BASE_URL/);
  });

  it("rejects non-numeric Telegram user IDs", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_TELEGRAM_BOT_TOKEN: "123:ABC",
      COGMO_TELEGRAM_ALLOWED_USERS: "100,not-a-number",
    });
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error.issues.join("\n")).toMatch(/not-a-number/);
  });

  it("requires allowed-users when a bot token is set", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_TELEGRAM_BOT_TOKEN: "123:ABC",
    });
    expect(r.isErr()).toBe(true);
    if (!r.isErr()) return;
    expect(r.error.issues.join("\n")).toMatch(/COGMO_TELEGRAM_ALLOWED_USERS/);
  });
});

// --- runNonInteractive ---

describe("runNonInteractive", () => {
  it("writes provider + model_providers + secret with only the required vars", async () => {
    const v = validators();
    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv(),
      validators: v,
    });

    const providers = await agentStore.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("anthropic");
    expect(providers[0]?.type).toBe("anthropic");

    const secretNames = (await secretsStore.listSecrets()).map((s) => s.name);
    expect(secretNames).toContain("anthropic_api_key");

    const mpRows = await db.select().from(modelProviders);
    expect(mpRows).toHaveLength(1);

    expect(v.llmAnthropic).toHaveBeenCalledWith("sk-ant-test-key-abc123xyz", undefined);
    expect(v.telegram).not.toHaveBeenCalled();
  });

  it("persists from the _FILE secret path", async () => {
    const path = tempFile("sk-from-secret-file-xxxxx");
    const v = validators();
    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env: {
        COGMO_LLM_PROVIDER_TYPE: "anthropic",
        COGMO_LLM_API_KEY_FILE: path,
      },
      validators: v,
    });

    expect(v.llmAnthropic).toHaveBeenCalledWith("sk-from-secret-file-xxxxx", undefined);
    const stored = await secretsStore.getSecret("anthropic_api_key");
    expect(stored).toBe("sk-from-secret-file-xxxxx");
  });

  it("writes Telegram channel + identities when bot token + allowed users supplied", async () => {
    const v = validators();
    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({
        COGMO_TELEGRAM_BOT_TOKEN: "123456:ABCdefGHIjkl",
        COGMO_TELEGRAM_ALLOWED_USERS: "100,200",
      }),
      validators: v,
    });

    const tg = await transportStore.getChannelByType("telegram");
    expect(tg).not.toBeNull();

    const identities = await db
      .select()
      .from(userIdentitiesTable)
      .where(eq(userIdentitiesTable.channelId, tg?.id ?? ""));
    const handles = identities.map((r) => r.platformHandle).filter(Boolean);
    expect(handles).toEqual(expect.arrayContaining(["100", "200"]));

    const secretMeta = await secretsStore.getSecretMeta("telegram_bot_token");
    expect(secretMeta?.description).toBe("Telegram bot token (@cogmo_test_bot)");
  });

  it("fails fast with no DB writes when required env vars are missing", async () => {
    await expect(
      runNonInteractive({
        agentStore,
        transportStore,
        secretsStore,
        env: {},
        validators: validators(),
      }),
    ).rejects.toBeInstanceOf(SetupEnvError);

    expect(await rowCount(db, llmProviders)).toBe(0);
    expect(await rowCount(db, modelProviders)).toBe(0);
    expect(await rowCount(db, channels)).toBe(0);
    expect(await rowCount(db, secretsTable)).toBe(0);
  });

  it("fails fast with no DB writes when the LLM key is rejected", async () => {
    const v = validators({
      llmAnthropic: vi.fn().mockResolvedValue({ valid: false, error: "Invalid API key" }),
    });

    await expect(
      runNonInteractive({
        agentStore,
        transportStore,
        secretsStore,
        env: baseEnv(),
        validators: v,
      }),
    ).rejects.toBeInstanceOf(NonInteractiveValidationError);

    expect(await rowCount(db, llmProviders)).toBe(0);
    expect(await rowCount(db, secretsTable)).toBe(0);
  });

  it("fails fast with no DB writes when the Telegram token is rejected", async () => {
    const v = validators({
      telegram: vi.fn().mockResolvedValue({ valid: false, error: "Unauthorized" }),
    });

    await expect(
      runNonInteractive({
        agentStore,
        transportStore,
        secretsStore,
        env: baseEnv({
          COGMO_TELEGRAM_BOT_TOKEN: "123:WRONG",
          COGMO_TELEGRAM_ALLOWED_USERS: "100",
        }),
        validators: v,
      }),
    ).rejects.toBeInstanceOf(NonInteractiveValidationError);

    expect(await rowCount(db, llmProviders)).toBe(0);
    expect(await rowCount(db, channels)).toBe(0);
    expect(await rowCount(db, userIdentitiesTable)).toBe(0);
    expect(await rowCount(db, secretsTable)).toBe(0);
  });

  it("applies OpenRouter attrs.promptCaching", async () => {
    const v = validators();
    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({
        COGMO_LLM_PROVIDER_TYPE: "openrouter",
        COGMO_LLM_API_KEY: "sk-or-test-0123456789",
      }),
      validators: v,
    });

    const rows = await db.select().from(llmProviders);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("openrouter");
    expect(rows[0]?.type).toBe("openai_compatible");
    expect(rows[0]?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(rows[0]?.attrs).toEqual({ promptCaching: true });
    expect(v.llmOpenAICompatible).toHaveBeenCalledWith(
      "sk-or-test-0123456789",
      "https://openrouter.ai/api/v1",
    );
  });

  it("uses custom baseUrl when provider type is custom", async () => {
    const v = validators();
    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({
        COGMO_LLM_PROVIDER_TYPE: "custom",
        COGMO_LLM_API_KEY: "sk-custom-0123456789",
        COGMO_LLM_BASE_URL: "https://my.llm.test/v1",
      }),
      validators: v,
    });

    const rows = await db.select().from(llmProviders);
    expect(rows[0]?.baseUrl).toBe("https://my.llm.test/v1");
    expect(v.llmOpenAICompatible).toHaveBeenCalledWith(
      "sk-custom-0123456789",
      "https://my.llm.test/v1",
    );
  });

  it("persists the Tavily key when supplied and validated", async () => {
    const v = validators();
    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({ COGMO_TAVILY_API_KEY: "tvly-0123456789" }),
      validators: v,
    });

    const stored = await secretsStore.getSecret("tavily_api_key");
    expect(stored).toBe("tvly-0123456789");
    expect(v.tavily).toHaveBeenCalled();
  });

  it("fails fast with no DB writes when Tavily key is rejected", async () => {
    const v = validators({
      tavily: vi.fn().mockResolvedValue({ valid: false, error: "Invalid API key" }),
    });

    await expect(
      runNonInteractive({
        agentStore,
        transportStore,
        secretsStore,
        env: baseEnv({ COGMO_TAVILY_API_KEY: "tvly-wrong-01234" }),
        validators: v,
      }),
    ).rejects.toBeInstanceOf(NonInteractiveValidationError);

    expect(await rowCount(db, secretsTable)).toBe(0);
  });

  // Sessions + channels leave data around on re-run unless --reset channels is used.
  // Non-interactive tolerates re-running on an existing Telegram channel by replacing it.
  it("replaces an existing Telegram channel on re-run", async () => {
    const v = validators();
    const env = baseEnv({
      COGMO_TELEGRAM_BOT_TOKEN: "111:ABC",
      COGMO_TELEGRAM_ALLOWED_USERS: "100",
    });

    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env,
      validators: v,
    });
    const firstId = (await transportStore.getChannelByType("telegram"))?.id;

    await runNonInteractive({
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({
        COGMO_TELEGRAM_BOT_TOKEN: "222:DEF",
        COGMO_TELEGRAM_ALLOWED_USERS: "100,200",
      }),
      validators: v,
    });
    const secondId = (await transportStore.getChannelByType("telegram"))?.id;

    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);

    // Only one Telegram channel remains.
    const allTelegram = (await transportStore.getAllChannels()).filter(
      (c) => c.type === "telegram",
    );
    expect(allTelegram).toHaveLength(1);
  });
});
