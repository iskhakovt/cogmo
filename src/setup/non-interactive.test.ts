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
import type { Database, Transactor } from "../db/index.js";
import { deriveMasterKey, generateMasterKey, parseMasterKey } from "../secrets/encryption.js";
import { GitHubIdentitySchema } from "../secrets/github.js";
import { DrizzleSecretsStore } from "../secrets/store/index.js";
import { secrets as secretsTable } from "../secrets/store/schema.js";
import { createTestDatabase, truncateAll } from "../test/pglite.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import { channels, userIdentities as userIdentitiesTable } from "../transport/store/schema.js";
import { SetupEnvError } from "./env.js";
import {
  NonInteractiveValidationError,
  runNonInteractive,
  type Validators,
} from "./non-interactive.js";
import type { ValidationResult } from "./validate.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let agentStore: DrizzleAgentStore;
let transportStore: DrizzleTransportStore;
let secretsStore: DrizzleSecretsStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  agentStore = new DrizzleAgentStore();
  transportStore = new DrizzleTransportStore();
  const key = deriveMasterKey(parseMasterKey(generateMasterKey()), "cogmo/secrets-at-rest/v1");
  secretsStore = new DrizzleSecretsStore(key);
});

afterEach(async () => {
  await truncateAll(db);
  vi.unstubAllEnvs();
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
    githubPat: vi
      .fn()
      .mockResolvedValue({ valid: true, meta: { login: "cogmo-bot", id: "12345" } }),
    daytonaApiKey: vi.fn().mockResolvedValue(okResult),
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

// --- runNonInteractive ---

describe("runNonInteractive", () => {
  it("writes provider + model_providers + secret with only the required vars", async () => {
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv(),
      validators: v,
    });

    const providers = await tx((trx) => agentStore.listProviders(trx));
    expect(providers).toHaveLength(1);
    expect(providers[0]?.name).toBe("anthropic");
    expect(providers[0]?.type).toBe("anthropic");

    const secretNames = (await tx((trx) => secretsStore.listSecrets(trx))).map((s) => s.name);
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
      runInTx: tx,
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
    const stored = await tx((trx) => secretsStore.getSecret(trx, "anthropic_api_key"));
    expect(stored).toBe("sk-from-secret-file-xxxxx");
  });

  it("writes Telegram channel + identities when bot token + allowed users supplied", async () => {
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({
        COGMO_TELEGRAM_BOT_TOKEN: "123456:ABCdefGHIjkl",
        COGMO_TELEGRAM_ALLOWED_USERS: "100,200",
      }),
      validators: v,
    });

    const tg = await tx((trx) => transportStore.getChannelByType(trx, "telegram"));
    expect(tg).not.toBeNull();

    const identities = await db
      .select()
      .from(userIdentitiesTable)
      .where(eq(userIdentitiesTable.channelId, tg?.id ?? ""));
    const handles = identities.map((r) => r.platformHandle).filter(Boolean);
    expect(handles).toEqual(expect.arrayContaining(["100", "200"]));

    const secretMeta = await tx((trx) => secretsStore.getSecretMeta(trx, "telegram_bot_token"));
    expect(secretMeta?.description).toBe("Telegram bot token (@cogmo_test_bot)");
  });

  it("fails fast with no DB writes when required env vars are missing", async () => {
    await expect(
      runNonInteractive({
        runInTx: tx,
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
        runInTx: tx,
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
        runInTx: tx,
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
      runInTx: tx,
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
      runInTx: tx,
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

  it("persists COGMO_CLAUDE_CODE_OAUTH_TOKEN as the claude_code_oauth_token secret", async () => {
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({ COGMO_CLAUDE_CODE_OAUTH_TOKEN: "sk-test-claude-oauth-token-1234" }),
      validators: v,
    });

    const stored = await tx((trx) => secretsStore.getSecret(trx, "claude_code_oauth_token"));
    expect(stored).toBe("sk-test-claude-oauth-token-1234");
  });

  it("persists COGMO_DAYTONA_API_KEY as the daytona_api_key secret", async () => {
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({ COGMO_DAYTONA_API_KEY: "dtn_test_api_key_abcdef0123456789" }),
      validators: v,
    });

    const stored = await tx((trx) => secretsStore.getSecret(trx, "daytona_api_key"));
    expect(stored).toBe("dtn_test_api_key_abcdef0123456789");
    expect(v.daytonaApiKey).toHaveBeenCalledWith("dtn_test_api_key_abcdef0123456789", {});
  });

  it("forwards DAYTONA_API_URL / DAYTONA_ORGANIZATION_ID to the validator", async () => {
    vi.stubEnv("DAYTONA_API_URL", "https://daytona.example.com/api");
    vi.stubEnv("DAYTONA_ORGANIZATION_ID", "org-7");

    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({ COGMO_DAYTONA_API_KEY: "dtn_test_api_key_abcdef0123456789" }),
      validators: v,
    });

    expect(v.daytonaApiKey).toHaveBeenCalledWith("dtn_test_api_key_abcdef0123456789", {
      apiUrl: "https://daytona.example.com/api",
      organizationId: "org-7",
    });
  });

  it("fails fast with no DB writes when the Daytona key is rejected", async () => {
    const v = validators({
      daytonaApiKey: vi
        .fn()
        .mockResolvedValue({ valid: false, error: "API key rejected (401 Unauthorized)" }),
    });

    await expect(
      runNonInteractive({
        runInTx: tx,
        agentStore,
        transportStore,
        secretsStore,
        env: baseEnv({ COGMO_DAYTONA_API_KEY: "dtn_test_api_key_abcdef0123456789" }),
        validators: v,
      }),
    ).rejects.toBeInstanceOf(NonInteractiveValidationError);

    expect(await rowCount(db, secretsTable)).toBe(0);
    expect(await rowCount(db, llmProviders)).toBe(0);
  });

  it("persists the Tavily key when supplied and validated", async () => {
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({ COGMO_TAVILY_API_KEY: "tvly-0123456789" }),
      validators: v,
    });

    const stored = await tx((trx) => secretsStore.getSecret(trx, "tavily_api_key"));
    expect(stored).toBe("tvly-0123456789");
    expect(v.tavily).toHaveBeenCalled();
  });

  it("fails fast with no DB writes when Tavily key is rejected", async () => {
    const v = validators({
      tavily: vi.fn().mockResolvedValue({ valid: false, error: "Invalid API key" }),
    });

    await expect(
      runNonInteractive({
        runInTx: tx,
        agentStore,
        transportStore,
        secretsStore,
        env: baseEnv({ COGMO_TAVILY_API_KEY: "tvly-wrong-01234" }),
        validators: v,
      }),
    ).rejects.toBeInstanceOf(NonInteractiveValidationError);

    expect(await rowCount(db, secretsTable)).toBe(0);
  });

  it("persists a GitHub identity bundle when COGMO_GITHUB_PAT is supplied", async () => {
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({ COGMO_GITHUB_PAT: "ghp_test_xxxxxxxxxxxxxxxxxxxx" }),
      validators: v,
    });

    expect(v.githubPat).toHaveBeenCalledWith("ghp_test_xxxxxxxxxxxxxxxxxxxx");

    const raw = await tx((trx) => secretsStore.getSecret(trx, "github_identity:default"));
    expect(raw).not.toBeNull();
    const parsed = GitHubIdentitySchema.parse(JSON.parse(raw ?? "{}"));
    expect(parsed.pat).toBe("ghp_test_xxxxxxxxxxxxxxxxxxxx");
    expect(parsed.sshPrivateKey).toMatch(/-----BEGIN OPENSSH PRIVATE KEY-----/);
    expect(parsed.sshPublicKey).toMatch(/^ssh-ed25519 /);
    expect(parsed.login).toBe("cogmo-bot");
    expect(parsed.id).toBe("12345");

    const meta = await tx((trx) => secretsStore.getSecretMeta(trx, "github_identity:default"));
    expect(meta?.description).toBe("GitHub identity (@cogmo-bot)");
    expect(meta?.validatedAt).toBeInstanceOf(Date);
  });

  it("does not store a GitHub identity when no PAT is supplied", async () => {
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv(),
      validators: v,
    });

    expect(v.githubPat).not.toHaveBeenCalled();
    expect(
      await tx((trx) => secretsStore.getSecret(trx, "github_identity:default")),
    ).toBeUndefined();
  });

  it("ignores COGMO_GITHUB_SSH_PRIVATE_KEY when no PAT is supplied", async () => {
    // Stale leftover env var on a wrapper script must not fail an
    // otherwise valid non-GitHub setup. The SSH key has no effect
    // without a PAT (no identity gets persisted), so silently dropping
    // it is the friendly behaviour.
    const v = validators();
    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({
        COGMO_GITHUB_SSH_PRIVATE_KEY:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nfoo\n-----END OPENSSH PRIVATE KEY-----",
      }),
      validators: v,
    });

    expect(v.githubPat).not.toHaveBeenCalled();
    expect(
      await tx((trx) => secretsStore.getSecret(trx, "github_identity:default")),
    ).toBeUndefined();
  });

  it("rejects COGMO_GITHUB_SSH_PRIVATE_KEY loudly (importing keys not yet supported)", async () => {
    const v = validators();
    await expect(
      runNonInteractive({
        runInTx: tx,
        agentStore,
        transportStore,
        secretsStore,
        env: baseEnv({
          COGMO_GITHUB_PAT: "ghp_test_xxxxxxxxxxxxxxxxxxxx",
          COGMO_GITHUB_SSH_PRIVATE_KEY:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nfoo\n-----END OPENSSH PRIVATE KEY-----",
        }),
        validators: v,
      }),
    ).rejects.toThrowError(/COGMO_GITHUB_SSH_PRIVATE_KEY.*supported/);

    // No identity persisted — the validation gate aborts before any DB write.
    expect(
      await tx((trx) => secretsStore.getSecret(trx, "github_identity:default")),
    ).toBeUndefined();
  });

  it("fails fast with no DB writes when COGMO_GITHUB_PAT is rejected", async () => {
    const v = validators({
      githubPat: vi
        .fn()
        .mockResolvedValue({ valid: false, error: "PAT rejected (401 Unauthorized)" }),
    });

    await expect(
      runNonInteractive({
        runInTx: tx,
        agentStore,
        transportStore,
        secretsStore,
        env: baseEnv({ COGMO_GITHUB_PAT: "ghp_invalid_xxxxxxxxxxxxxxx" }),
        validators: v,
      }),
    ).rejects.toBeInstanceOf(NonInteractiveValidationError);

    expect(await rowCount(db, llmProviders)).toBe(0);
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
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env,
      validators: v,
    });
    const firstId = (await tx((trx) => transportStore.getChannelByType(trx, "telegram")))?.id;

    await runNonInteractive({
      runInTx: tx,
      agentStore,
      transportStore,
      secretsStore,
      env: baseEnv({
        COGMO_TELEGRAM_BOT_TOKEN: "222:DEF",
        COGMO_TELEGRAM_ALLOWED_USERS: "100,200",
      }),
      validators: v,
    });
    const secondId = (await tx((trx) => transportStore.getChannelByType(trx, "telegram")))?.id;

    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);

    // Only one Telegram channel remains.
    const allTelegram = (await tx((trx) => transportStore.getAllChannels(trx))).filter(
      (c) => c.type === "telegram",
    );
    expect(allTelegram).toHaveLength(1);
  });
});
