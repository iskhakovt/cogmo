/**
 * Unit tests for `src/setup/wizard.ts`'s `step…` functions.
 *
 * Mocking strategy:
 *
 *   - `@clack/prompts` is the prompt boundary. Every interactive call —
 *     `select`, `confirm`, `password`, `text`, `spinner`, `note`, `log.*`
 *     — is stubbed at module scope so tests drive deterministic prompt
 *     responses with `mockResolvedValueOnce` / `mockReturnValueOnce`.
 *
 *   - Real-API modules used by individual steps are mocked one at a
 *     time, keeping each step's collaborator surface explicit:
 *       - `./validate.js` (HTTP probes against provider APIs)
 *       - `./seed.js` (DB seeding helpers)
 *       - `./env.js` (frozen `env` proxy so `process.env` reads stay
 *         deterministic — pair with `vi.stubEnv` in tests that need to
 *         override specific keys)
 *       - `../secrets/ssh-keygen.js` (SSH key material)
 *       - `../skills/repo.js`, `../skills/configure-remote.js`,
 *         `../skills/configure-remote-prompts.js` (skills-remote flow)
 *       - `../agent/coding/store/index.js`,
 *         `../agent/provider/{add-provider,discover-models,add-model-routing}.js`
 *         (LLM provider registration)
 *
 *   - Stores (`AgentStore`, `SecretsStore`, `TransportStore`) are typed
 *     stubs from `vitest-mock-extended`'s `mock<T>()`. Tests drive each
 *     step's queries via `deps.secretsStore.getSecretMeta.mockResolvedValue`
 *     etc.
 *
 * If a future refactor moves I/O across modules, the mock list above
 * needs to follow. The single-module-per-mock layout is deliberate —
 * one mistakenly-overlapping mock would hide a step's real collaborator
 * surface from the tests.
 */
import * as p from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { runClackValidate } from "../test/assertions.js";
import type { TransportStore } from "../transport/store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  // `wizard.ts:pickModelInteractive` calls `p.autocomplete` when the
  // provider's discovery returns a non-empty model list. Today's tests
  // mock that to `[]` and hit the `p.text` fallback, but include the mock
  // so future tests exercising the discovered-models path don't crash
  // with "p.autocomplete is not a function".
  autocomplete: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  note: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  isCancel: vi.fn(() => false),
}));

const {
  validateClaudeCodeOauthTokenSpy,
  validateDaytonaApiKeySpy,
  validateHindsightSpy,
  validateTavilyKeySpy,
  validateTelegramTokenSpy,
} = vi.hoisted(() => ({
  validateClaudeCodeOauthTokenSpy: vi.fn(),
  validateDaytonaApiKeySpy: vi.fn(),
  validateHindsightSpy: vi.fn(),
  validateTavilyKeySpy: vi.fn(),
  validateTelegramTokenSpy: vi.fn(),
}));

const { validateGitHubPatSpy } = vi.hoisted(() => ({
  validateGitHubPatSpy: vi.fn(),
}));

vi.mock("./validate.js", () => ({
  validateClaudeCodeOauthToken: validateClaudeCodeOauthTokenSpy,
  validateDaytonaApiKey: validateDaytonaApiKeySpy,
  validateHindsight: validateHindsightSpy,
  validateTavilyKey: validateTavilyKeySpy,
  validateTelegramToken: validateTelegramTokenSpy,
  validateAnthropicKey: vi.fn(),
  validateOpenAIKey: vi.fn(),
  validateOpenRouterKey: vi.fn(),
  validateCustomKey: vi.fn(),
  validateGitHubPat: validateGitHubPatSpy,
}));

vi.mock("./seed.js", () => ({
  seedDefaults: vi.fn().mockResolvedValue({ userId: "u-1", profileId: "prof-1" }),
  seedChannelRules: vi.fn().mockResolvedValue(undefined),
  ensureFalImageDefaults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./env.js", () => ({
  env: {
    COGMO_SKILLS_PATH: "/tmp/cogmo-skills-test",
    HINDSIGHT_URL: "http://localhost:8888",
  },
}));

vi.mock("../secrets/ssh-keygen.js", () => ({
  generateSshKeyPair: vi.fn(() => ({
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake-priv\n-----END OPENSSH PRIVATE KEY-----",
    publicKey: "ssh-ed25519 AAAAfake cogmo-bot",
    fingerprint: "SHA256:fake-fingerprint",
  })),
}));

const {
  bootstrapSkillsRepoSpy,
  readOriginUrlSpy,
  ensureSkillsCodingRepoSpy,
  configureSkillsRemoteSpy,
} = vi.hoisted(() => ({
  bootstrapSkillsRepoSpy: vi.fn(),
  readOriginUrlSpy: vi.fn(),
  ensureSkillsCodingRepoSpy: vi.fn(),
  configureSkillsRemoteSpy: vi.fn(),
}));

vi.mock("../skills/repo.js", () => ({
  bootstrapSkillsRepo: bootstrapSkillsRepoSpy,
  readOriginUrl: readOriginUrlSpy,
  ensureSkillsCodingRepo: ensureSkillsCodingRepoSpy,
  SKILLS_CODING_REPO_NAME: "skills",
}));

vi.mock("../skills/configure-remote.js", () => ({
  configureSkillsRemote: configureSkillsRemoteSpy,
  AUTO_PROVISION_REPO_NAME: "cogmo-skills",
}));

vi.mock("../skills/configure-remote-prompts.js", () => ({
  collectSkillsRemoteMode: vi.fn().mockResolvedValue({ kind: "skip" }),
  renderConfigureError: vi.fn(),
  readLocalMainSha: vi.fn(async () => null),
}));

vi.mock("../agent/coding/store/index.js", () => ({
  DrizzleCodingStore: class {},
}));

const { addProviderSpy } = vi.hoisted(() => ({
  addProviderSpy: vi.fn(),
}));

vi.mock("../agent/provider/add-provider.js", () => ({
  addProvider: addProviderSpy,
}));

vi.mock("../agent/provider/discover-models.js", () => ({
  discoverModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("../agent/provider/add-model-routing.js", () => ({
  addModelRouting: vi.fn().mockResolvedValue({ id: "row-1", position: 0 }),
}));

const {
  stepConfigureClaudeCodeAuth,
  stepConfigureDaytona,
  stepValidateHindsight,
  stepSummary,
  stepConfigureOptionalTools,
  stepConfigureTelegram,
  stepConfigureGitHubIdentity,
  stepConfigureSkillsRemote,
  stepConfigureProvider,
  stepConfigureImageProviders,
  WizardCancelled,
} = await import("./wizard.js");

const { ok, err } = await import("neverthrow");

const { CLAUDE_CODE_OAUTH_TOKEN_SECRET } = await import("../agent/coding/auth.js");
const { DAYTONA_API_KEY_SECRET } = await import("../sandbox/daytona/auth.js");

interface TestDeps {
  agentStore: ReturnType<typeof mock<AgentStore>>;
  secretsStore: ReturnType<typeof mock<SecretsStore>>;
  transportStore: ReturnType<typeof mock<TransportStore>>;
  runInTx: Transactor;
}

function buildDeps(): TestDeps {
  const agentStore = mock<AgentStore>();
  const secretsStore = mock<SecretsStore>();
  const transportStore = mock<TransportStore>();
  secretsStore.putSecret.mockResolvedValue({ id: "s-1" });
  secretsStore.markValidated.mockResolvedValue(undefined);
  secretsStore.getSecretMeta.mockResolvedValue(undefined);
  return { agentStore, secretsStore, transportStore, runInTx: fakeRunInTx };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore any `process.env` keys swapped via `vi.stubEnv` in a prior
  // test so state can't leak. Matches the pattern in
  // `src/db/transactor.test.ts` and `src/setup/non-interactive.test.ts`.
  vi.unstubAllEnvs();
  // mockResolvedValueOnce / mockReturnValueOnce queues survive
  // vi.clearAllMocks; reset them explicitly so leftover queued returns
  // from a previous test don't bleed into the next prompt sequence.
  vi.mocked(p.confirm).mockReset();
  vi.mocked(p.password).mockReset();
  vi.mocked(p.text).mockReset();
  vi.mocked(p.select).mockReset();
  vi.mocked(p.isCancel).mockReset().mockReturnValue(false);
  validateClaudeCodeOauthTokenSpy.mockReset();
  validateDaytonaApiKeySpy.mockReset();
  validateHindsightSpy.mockReset();
  validateTavilyKeySpy.mockReset();
  validateTelegramTokenSpy.mockReset();
  validateGitHubPatSpy.mockReset();
  bootstrapSkillsRepoSpy.mockReset();
  readOriginUrlSpy.mockReset();
  ensureSkillsCodingRepoSpy.mockReset();
  configureSkillsRemoteSpy.mockReset();
  addProviderSpy.mockReset();
});

describe("stepConfigureClaudeCodeAuth", () => {
  it("skips when no existing token AND user declines the prompt", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("keeps existing token when 'keep' is selected", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecretMeta.mockResolvedValue({
      id: "s-1",
      name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
      description: "",
      validatedAt: null,
    });
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: stores trimmed token and marks validated when validation passes", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("  sk-ant-oauth-very-long-token-xx\n");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: true });

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
        plaintext: "sk-ant-oauth-very-long-token-xx",
      }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(
      FAKE_TX,
      CLAUDE_CODE_OAUTH_TOKEN_SECRET,
    );
  });

  it("stores token without markValidated when validation fails but user opts to save anyway", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial proceed
    vi.mocked(p.password).mockResolvedValueOnce("sk-this-is-also-long-enough-yes");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: false, error: "401" });
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // save anyway

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalled();
    expect(deps.secretsStore.markValidated).not.toHaveBeenCalled();
  });

  it("skips the write entirely when validation fails AND user declines save-anyway", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // initial proceed
    vi.mocked(p.password).mockResolvedValueOnce("sk-this-is-also-long-enough-yes");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: false, error: "401" });
    vi.mocked(p.confirm).mockResolvedValueOnce(false); // save anyway → no

    await stepConfigureClaudeCodeAuth(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("rejects short tokens via the validator callback", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("sk-long-enough-token-for-test");
    validateClaudeCodeOauthTokenSpy.mockResolvedValueOnce({ valid: true });

    await stepConfigureClaudeCodeAuth(deps);

    const passCall = vi.mocked(p.password).mock.calls[0]?.[0];
    expect(runClackValidate(passCall?.validate, "")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "short")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "sk-this-is-long-enough-for-real")).toBeUndefined();
  });

  it("throws WizardCancelled when select is cancelled", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecretMeta.mockResolvedValue({
      id: "s-1",
      name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
      description: "",
      validatedAt: null,
    });
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(true);

    await expect(stepConfigureClaudeCodeAuth(deps)).rejects.toBeInstanceOf(WizardCancelled);
  });
});

describe("stepConfigureDaytona", () => {
  it("skips when user declines the optional prompt", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("keeps existing key when 'keep' is selected", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecretMeta.mockResolvedValue({
      id: "s-d",
      name: DAYTONA_API_KEY_SECRET,
      description: "",
      validatedAt: null,
    });
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: stores key and marks validated when probe passes", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("daytona-pat-very-long-token-xx");
    validateDaytonaApiKeySpy.mockResolvedValueOnce({ valid: true });

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: DAYTONA_API_KEY_SECRET }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, DAYTONA_API_KEY_SECRET);
  });

  it("threads DAYTONA_API_URL and DAYTONA_ORGANIZATION_ID env into the probe opts", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("daytona-pat-very-long-token-xx");
    validateDaytonaApiKeySpy.mockResolvedValueOnce({ valid: true });
    // Mirrors `src/setup/non-interactive.test.ts:326-327` — same env vars,
    // same idiom. `vi.unstubAllEnvs()` in `beforeEach` restores afterwards.
    vi.stubEnv("DAYTONA_API_URL", "http://self-hosted/api");
    vi.stubEnv("DAYTONA_ORGANIZATION_ID", "org-xyz");

    await stepConfigureDaytona(deps);

    expect(validateDaytonaApiKeySpy).toHaveBeenCalledWith(
      "daytona-pat-very-long-token-xx",
      expect.objectContaining({ apiUrl: "http://self-hosted/api", organizationId: "org-xyz" }),
    );
  });

  it("falls through with save-anyway=false when validation fails", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("daytona-pat-very-long-token-xx");
    validateDaytonaApiKeySpy.mockResolvedValueOnce({ valid: false, error: "bad" });
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureDaytona(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });
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

describe("stepSummary", () => {
  it("renders 'configured' line for telegram when channel exists, includes botUsername next-step", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([
      { id: "p-1", name: "anthropic", type: "anthropic", baseUrl: null, secretId: "s-1" } as never,
    ]);
    deps.secretsStore.listSecrets.mockResolvedValue([
      { id: "s-1", name: "x", description: "", validatedAt: new Date() },
    ] as never);
    deps.transportStore.getChannelByType.mockResolvedValue({
      id: "ch-1",
      type: "telegram",
    } as never);
    deps.agentStore.getVoiceConfig.mockResolvedValue(undefined);

    await stepSummary(deps, "cogmo_bot");

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/Telegram: configured/),
      "Setup complete",
    );
    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/@cogmo_bot/),
      "Verify it's running",
    );
  });

  it("falls back to 'use pnpm console' next-step when no telegram channel is configured", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    deps.secretsStore.listSecrets.mockResolvedValue([]);
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    deps.agentStore.getVoiceConfig.mockResolvedValue(undefined);

    await stepSummary(deps);

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/Telegram: not configured/),
      "Setup complete",
    );
    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/pnpm console/),
      "Verify it's running",
    );
  });

  it("renders voice 'configured (model/voice)' when a voice_config row exists", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    deps.secretsStore.listSecrets.mockResolvedValue([]);
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    deps.agentStore.getVoiceConfig.mockResolvedValue({
      id: "v-1",
      ttsSecretId: "s",
      sttSecretId: "s",
      ttsProvider: "openai",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "alloy",
      ttsBaseUrl: null,
      sttProvider: "openai",
      sttModel: "gpt-4o-mini-transcribe",
      sttBaseUrl: null,
    } as never);

    await stepSummary(deps);

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/Voice: configured \(gpt-4o-mini-tts\/alloy\)/),
      "Setup complete",
    );
  });

  it("when telegram exists but no botUsername arg is passed, surfaces the generic message-bot hint", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    deps.secretsStore.listSecrets.mockResolvedValue([]);
    deps.transportStore.getChannelByType.mockResolvedValue({
      id: "ch-1",
      type: "telegram",
    } as never);
    deps.agentStore.getVoiceConfig.mockResolvedValue(undefined);

    await stepSummary(deps);

    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringMatching(/message your configured bot/),
      "Verify it's running",
    );
  });
});

describe("stepConfigureOptionalTools", () => {
  it("skips when user declines to configure tools", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("stores tavily key when validation succeeds and fal key without validation", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("tavily-key"); // tavily
    validateTavilyKeySpy.mockResolvedValueOnce({ valid: true });
    vi.mocked(p.password).mockResolvedValueOnce("fal-key"); // fal

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "tavily_api_key" }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, "tavily_api_key");
    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "fal_api_key" }),
    );
  });

  it("does not persist tavily key when validation fails", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("tavily-bad");
    validateTavilyKeySpy.mockResolvedValueOnce({ valid: false, error: "401" });
    vi.mocked(p.password).mockResolvedValueOnce(""); // skip fal

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("skips both keys when both passwords are empty (Enter to skip)", async () => {
    const deps = buildDeps();
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("");
    vi.mocked(p.password).mockResolvedValueOnce("");

    await stepConfigureOptionalTools(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(validateTavilyKeySpy).not.toHaveBeenCalled();
  });
});

describe("stepConfigureTelegram", () => {
  it("keeps existing channel when 'keep' is selected and seeds channel rules", async () => {
    const deps = buildDeps();
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
    const deps = buildDeps();
    deps.transportStore.getChannelByType.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    const result = await stepConfigureTelegram(deps, "u-1");

    expect(result).toEqual({});
    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: validates token, creates channel + identity rows for each allowlisted user", async () => {
    const deps = buildDeps();
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
    const deps = buildDeps();
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
    const deps = buildDeps();
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
    const deps = buildDeps();
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
    const deps = buildDeps();
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

describe("stepConfigureGitHubIdentity", () => {
  // resolveGitHubIdentity reads via secretsStore.getSecret; we stub by setting
  // the named secret key. gitHubIdentitySecretName("default") = "github_identity:default".
  const IDENTITY_KEY = "github_identity:default";

  it("skips entirely when no existing row AND user declines the optional prompt", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("keeps existing identity when 'keep' is selected", async () => {
    const deps = buildDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("happy path: full provision — validates PAT, generates keypair, stores + marks validated", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // proceed with provision
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "cogmo-bot", id: "1234" },
    });
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // SSH key installed confirm

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: IDENTITY_KEY }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, IDENTITY_KEY);
  });

  it("bails when validateGitHubPat fails — no rows written", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("ghp_bad_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({ valid: false, error: "401" });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("bails when validator returns valid but login/id are missing", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("ghp_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({ valid: true, meta: {} });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("'replace' rotates the PAT but reuses the stored signing key", async () => {
    const deps = buildDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "cogmo-bot", id: "1234" },
    });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: IDENTITY_KEY }),
    );
    expect(deps.secretsStore.markValidated).toHaveBeenCalledWith(FAKE_TX, IDENTITY_KEY);
  });

  it("'replace' refuses to swap a PAT for a different login (signature mismatch)", async () => {
    const deps = buildDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "different-account", id: "9999" },
    });

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
  });

  it("'regenerate' falls through to full provision", async () => {
    const deps = buildDeps();
    const stored = {
      pat: "ghp_existing_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n-----END OPENSSH PRIVATE KEY-----",
      sshPublicKey: "ssh-ed25519 AAAA bot",
      login: "cogmo-bot",
      id: "1234",
    };
    deps.secretsStore.getSecret.mockResolvedValue(JSON.stringify(stored));
    vi.mocked(p.select).mockResolvedValueOnce("regenerate");
    vi.mocked(p.password).mockResolvedValueOnce("ghp_new_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "cogmo-bot", id: "1234" },
    });
    vi.mocked(p.confirm).mockResolvedValueOnce(true); // SSH installed

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalled();
    expect(deps.secretsStore.markValidated).toHaveBeenCalled();
  });

  it("malformed stored JSON: confirms before overwriting", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecret.mockResolvedValue("{not json"); // resolveGitHubIdentity → malformed_json
    vi.mocked(p.confirm).mockResolvedValueOnce(false); // decline overwrite

    await stepConfigureGitHubIdentity(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringMatching(/could not be parsed/),
    );
  });

  it("PAT validator rejects short strings", async () => {
    const deps = buildDeps();
    deps.secretsStore.getSecret.mockResolvedValue(undefined);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.password).mockResolvedValueOnce("ghp_pat_long_enough_to_pass_22");
    validateGitHubPatSpy.mockResolvedValueOnce({
      valid: true,
      meta: { login: "u", id: "1" },
    });
    vi.mocked(p.confirm).mockResolvedValueOnce(true);

    await stepConfigureGitHubIdentity(deps);

    const passCall = vi.mocked(p.password).mock.calls[0]?.[0];
    expect(runClackValidate(passCall?.validate, "")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "ghp_x")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "ghp_long_enough_pat_value")).toBeUndefined();
  });
});

describe("stepConfigureSkillsRemote", () => {
  it("when origin is already set and operator picks 'keep', syncs DB row and returns", async () => {
    const deps = buildDeps();
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce("git@github.com:me/cogmo-skills.git");
    vi.mocked(p.select).mockResolvedValueOnce("keep");
    ensureSkillsCodingRepoSpy.mockResolvedValueOnce({ kind: "unchanged" });

    await stepConfigureSkillsRemote(deps);

    expect(ensureSkillsCodingRepoSpy).toHaveBeenCalled();
    expect(configureSkillsRemoteSpy).not.toHaveBeenCalled();
  });

  it("when 'replace' is selected, falls through to collectSkillsRemoteMode and configureSkillsRemote", async () => {
    const deps = buildDeps();
    const { collectSkillsRemoteMode } = await import("../skills/configure-remote-prompts.js");
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: true });
    readOriginUrlSpy.mockResolvedValueOnce("git@github.com:me/cogmo-skills.git");
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    vi.mocked(collectSkillsRemoteMode).mockResolvedValueOnce({
      kind: "own",
      direction: "publish",
      remoteUrl: "git@github.com:new/cogmo-skills.git",
    });
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      ok({
        kind: "configured",
        remoteUrl: "git@github.com:new/cogmo-skills.git",
        direction: "publish",
        originAction: "updated",
        ensured: { kind: "created" },
        backupPath: "/tmp/backup-1.json",
      }),
    );

    await stepConfigureSkillsRemote(deps);

    expect(configureSkillsRemoteSpy).toHaveBeenCalled();
  });

  it("warns and returns when configureSkillsRemote yields {kind:'skipped'}", async () => {
    const deps = buildDeps();
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(ok({ kind: "skipped" }));

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.warn)).toHaveBeenCalledWith(
      expect.stringMatching(/Skills remote not configured/),
    );
  });

  it("renders the error when configureSkillsRemote returns Err", async () => {
    const deps = buildDeps();
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      err({ kind: "url_invalid", remoteUrl: "x", reason: "bad" }),
    );
    const { renderConfigureError } = await import("../skills/configure-remote-prompts.js");

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(renderConfigureError)).toHaveBeenCalled();
  });

  it("logs the success message with 'published to' when direction is 'publish'", async () => {
    const deps = buildDeps();
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      ok({
        kind: "configured",
        remoteUrl: "git@github.com:me/cogmo-skills.git",
        direction: "publish",
        originAction: "attached",
        ensured: { kind: "created" },
        backupPath: null,
      }),
    );

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.success)).toHaveBeenCalledWith(
      expect.stringMatching(/Skills remote published to:/),
    );
  });

  it("logs the success message with 'adopted from' when direction is 'adopt'", async () => {
    const deps = buildDeps();
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: false });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(
      ok({
        kind: "configured",
        remoteUrl: "git@github.com:me/cogmo-skills.git",
        direction: "adopt",
        originAction: "attached",
        ensured: { kind: "created" },
        backupPath: "/tmp/b",
      }),
    );

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.success)).toHaveBeenCalledWith(
      expect.stringMatching(/Skills remote adopted from:/),
    );
  });

  it("reports bare-repo initialization when bootstrapSkillsRepo returns initialized:true", async () => {
    const deps = buildDeps();
    bootstrapSkillsRepoSpy.mockResolvedValueOnce({ initialized: true });
    readOriginUrlSpy.mockResolvedValueOnce(null);
    configureSkillsRemoteSpy.mockResolvedValueOnce(ok({ kind: "skipped" }));

    await stepConfigureSkillsRemote(deps);

    expect(vi.mocked(p.log.info)).toHaveBeenCalledWith(
      expect.stringMatching(/Initialized bare skills repo/),
    );
  });
});

describe("stepConfigureProvider", () => {
  it("'keep' returns without touching addProvider or stepAdd*", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([
      { id: "p-1", name: "anthropic", type: "anthropic", baseUrl: null, secretId: "s" } as never,
    ]);
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureProvider(deps);

    expect(addProviderSpy).not.toHaveBeenCalled();
  });

  it("'replace' deletes every existing provider before re-prompting for type", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([
      { id: "p-1", name: "anthropic", type: "anthropic", baseUrl: null, secretId: "s" } as never,
      {
        id: "p-2",
        name: "openrouter",
        type: "openai_compatible",
        baseUrl: null,
        secretId: "s2",
      } as never,
    ]);
    deps.agentStore.deleteProvider.mockResolvedValue(undefined);
    vi.mocked(p.select).mockResolvedValueOnce("replace");
    // After deletion, the wizard prompts for new provider type — make this throw via cancel
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    expect(deps.agentStore.deleteProvider).toHaveBeenCalledTimes(2);
  });

  it("provider-type select followed by cancel throws WizardCancelled", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([]); // no existing providers
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);
  });

  it("validates API key length via the validator callback", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    addProviderSpy.mockResolvedValue({
      providerId: "p-new",
      validation: { valid: true },
    });
    vi.mocked(p.select).mockResolvedValueOnce("anthropic"); // provider type
    vi.mocked(p.password).mockResolvedValueOnce("very-long-api-key-here-12345");
    // bail-out on the discover/add-model select chain
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    const passCall = vi.mocked(p.password).mock.calls[0]?.[0];
    expect(runClackValidate(passCall?.validate, "")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "short")).toMatch(/too short/);
    expect(runClackValidate(passCall?.validate, "a long enough api key")).toBeUndefined();
  });

  it("custom provider: prompts for base URL before API key", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    vi.mocked(p.select).mockResolvedValueOnce("custom"); // provider type
    vi.mocked(p.text).mockResolvedValueOnce("https://api.example.com/v1");
    // Cancel at the password prompt to bail out cleanly without driving
    // through addProvider / stepAddModelsForProvider.
    vi.mocked(p.password).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // select
      .mockReturnValueOnce(false) // text (URL)
      .mockReturnValueOnce(true); // password

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    expect(vi.mocked(p.text)).toHaveBeenCalledTimes(1);
    const textCall = vi.mocked(p.text).mock.calls[0]?.[0];
    expect(textCall?.message).toMatch(/Base URL/);
  });

  it("when no existing providers, no first select prompt is shown", async () => {
    const deps = buildDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    vi.mocked(p.select).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel).mockReturnValueOnce(true);

    await expect(stepConfigureProvider(deps)).rejects.toBeInstanceOf(WizardCancelled);

    // Only one select call should fire (the provider-type prompt), not two
    // (keep/replace/add then provider-type).
    expect(vi.mocked(p.select)).toHaveBeenCalledTimes(1);
    const selectMessage = vi.mocked(p.select).mock.calls[0]?.[0]?.message ?? "";
    expect(selectMessage).toMatch(/Choose your LLM provider/);
  });
});

describe("stepConfigureImageProviders", () => {
  it("no existing providers AND user declines → skips entirely", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureImageProviders(deps);

    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(deps.agentStore.createImageProvider).not.toHaveBeenCalled();
  });

  it("filters out fal providers when deciding whether to show 'keep/add/add-model'", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([
      { id: "fal-1", name: "fal", type: "fal", baseUrl: null, secretId: "s", attrs: {} } as never,
    ]);
    // Since only fal exists, nonFalExisting is empty → confirm path runs.
    vi.mocked(p.confirm).mockResolvedValueOnce(false);

    await stepConfigureImageProviders(deps);

    expect(vi.mocked(p.confirm)).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/Configure an OpenAI-compatible or Venice/),
      }),
    );
  });

  it("existing non-fal provider + 'keep' returns without further prompts", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([
      {
        id: "v-1",
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        secretId: "s",
        attrs: {},
      } as never,
    ]);
    vi.mocked(p.select).mockResolvedValueOnce("keep");

    await stepConfigureImageProviders(deps);

    expect(deps.agentStore.createImageProvider).not.toHaveBeenCalled();
    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
  });

  it("'add-model' delegates to stepAddImageModelToExisting (prompts for which provider)", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([
      {
        id: "v-1",
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        secretId: "s",
        attrs: {},
      } as never,
    ]);
    vi.mocked(p.select).mockResolvedValueOnce("add-model");
    // promptAddImageModels: first prompt is a confirm "Add a model?".
    // Decline so we exit cleanly.
    vi.mocked(p.select).mockResolvedValueOnce("v-1"); // which provider
    vi.mocked(p.confirm).mockResolvedValueOnce(false); // decline first add

    await stepConfigureImageProviders(deps);

    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
    // The first select asked the keep/add/add-model question.
    const selectCalls = vi.mocked(p.select).mock.calls;
    expect(selectCalls[0]?.[0]?.message).toMatch(/Image provider\(s\) configured/);
    expect(selectCalls[1]?.[0]?.message).toMatch(/Which provider/);
  });

  it("happy path: adds a non-fal provider when no existing + user accepts", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    deps.agentStore.createImageProvider.mockResolvedValue({ id: "p-new" });
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true) // proceed
      .mockResolvedValueOnce(true) // safe_mode default
      .mockResolvedValueOnce(false); // promptAddImageModels: decline first add
    vi.mocked(p.select).mockResolvedValueOnce("venice"); // provider type
    vi.mocked(p.text)
      .mockResolvedValueOnce("venice") // provider name
      .mockResolvedValueOnce("https://api.venice.ai/api/v1"); // base url
    vi.mocked(p.password).mockResolvedValueOnce("venice-key-very-long-abcdef");

    await stepConfigureImageProviders(deps);

    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "venice_api_key" }),
    );
    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        attrs: { imageGenerationDefaults: { safe_mode: true } },
      }),
    );
  });

  it("openai_compatible: no safe_mode prompt, attrs stay empty", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    deps.agentStore.createImageProvider.mockResolvedValue({ id: "p-new" });
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true) // proceed
      .mockResolvedValueOnce(false); // promptAddImageModels first add → no
    vi.mocked(p.select).mockResolvedValueOnce("openai_compatible");
    vi.mocked(p.text)
      .mockResolvedValueOnce("openai")
      .mockResolvedValueOnce("https://api.openai.com/v1");
    vi.mocked(p.password).mockResolvedValueOnce("sk-openai-very-long-abcdef-key");

    await stepConfigureImageProviders(deps);

    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ type: "openai_compatible", attrs: {} }),
    );
  });

  it("createImageProvider failure: logs error and returns without further work", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    deps.agentStore.createImageProvider.mockRejectedValue(new Error("UNIQUE constraint"));
    vi.mocked(p.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(p.select).mockResolvedValueOnce("venice");
    vi.mocked(p.text)
      .mockResolvedValueOnce("venice")
      .mockResolvedValueOnce("https://api.venice.ai/api/v1");
    vi.mocked(p.password).mockResolvedValueOnce("venice-key-very-long-abc-def");

    await stepConfigureImageProviders(deps);

    // putSecret was attempted; createImageProvider threw; no model prompts should follow.
    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
  });

  it("validator: provider name rejects shell-unsafe chars", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.select).mockResolvedValueOnce("venice");
    vi.mocked(p.text).mockResolvedValueOnce("venice");
    // Cancel later via isCancel
    vi.mocked(p.text).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // select provider-type
      .mockReturnValueOnce(false) // text name
      .mockReturnValueOnce(true); // text baseUrl → cancel

    await expect(stepConfigureImageProviders(deps)).rejects.toBeInstanceOf(WizardCancelled);

    const nameCall = vi.mocked(p.text).mock.calls[0]?.[0];
    expect(runClackValidate(nameCall?.validate, "Bad Name!")).toMatch(/Lowercase/);
    expect(runClackValidate(nameCall?.validate, "venice")).toBeUndefined();
  });

  it("validator: base URL must start with https:// and reject trailing slash", async () => {
    const deps = buildDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    vi.mocked(p.confirm).mockResolvedValueOnce(true);
    vi.mocked(p.select).mockResolvedValueOnce("venice");
    vi.mocked(p.text)
      .mockResolvedValueOnce("venice")
      .mockResolvedValueOnce("https://api.venice.ai/api/v1");
    vi.mocked(p.password).mockResolvedValueOnce(Symbol.for("clack:cancel") as unknown as string);
    vi.mocked(p.isCancel)
      .mockReturnValueOnce(false) // select
      .mockReturnValueOnce(false) // text name
      .mockReturnValueOnce(false) // text baseUrl
      .mockReturnValueOnce(true); // password → cancel

    await expect(stepConfigureImageProviders(deps)).rejects.toBeInstanceOf(WizardCancelled);

    const baseUrlCall = vi.mocked(p.text).mock.calls[1]?.[0];
    expect(runClackValidate(baseUrlCall?.validate, "http://insecure")).toMatch(/https/);
    expect(runClackValidate(baseUrlCall?.validate, "https://api.example.com/")).toMatch(
      /trailing slash/,
    );
    expect(runClackValidate(baseUrlCall?.validate, "https://api.example.com")).toBeUndefined();
  });
});
