/**
 * Unit tests for the non-interactive setup env parser.
 *
 * Pure parser tests — no DB, no network. The persistence and validation
 * concerns are tested in `non-interactive.test.ts`.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNonInteractiveEnv, SetupEnvError } from "./env.js";

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cogmo-env-test-"));
  const path = join(dir, "secret.txt");
  writeFileSync(path, content);
  return path;
}

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

  it("accepts COGMO_GITHUB_PAT and exposes it as `githubPat`", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_GITHUB_PAT: "ghp_test_xxxxxxxxxxxxxxxxxxxx",
    });
    if (r.isErr()) throw r.error;
    expect(r.value.githubPat).toBe("ghp_test_xxxxxxxxxxxxxxxxxxxx");
  });

  it("reads COGMO_GITHUB_PAT from the _FILE variant", () => {
    const path = tempFile("ghp_from_file_xxxxxxxxxxxxxxx");
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_GITHUB_PAT_FILE: path,
    });
    if (r.isErr()) throw r.error;
    expect(r.value.githubPat).toBe("ghp_from_file_xxxxxxxxxxxxxxx");
  });

  it("accepts COGMO_GITHUB_SSH_PRIVATE_KEY alongside the PAT", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_GITHUB_PAT: "ghp_test_xxxxxxxxxxxxxxxxxxxx",
      COGMO_GITHUB_SSH_PRIVATE_KEY:
        "-----BEGIN OPENSSH PRIVATE KEY-----\nfoo\n-----END OPENSSH PRIVATE KEY-----",
    });
    if (r.isErr()) throw r.error;
    expect(r.value.githubSshPrivateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("accepts COGMO_CLAUDE_CODE_OAUTH_TOKEN and exposes it as `claudeCodeOauthToken`", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_CLAUDE_CODE_OAUTH_TOKEN: "sk-claude-code-token-xxxxxxxx",
    });
    if (r.isErr()) throw r.error;
    expect(r.value.claudeCodeOauthToken).toBe("sk-claude-code-token-xxxxxxxx");
  });

  it("reads COGMO_CLAUDE_CODE_OAUTH_TOKEN from the _FILE variant", () => {
    const path = tempFile("sk-claude-code-from-file-xxxxxx");
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_CLAUDE_CODE_OAUTH_TOKEN_FILE: path,
    });
    if (r.isErr()) throw r.error;
    expect(r.value.claudeCodeOauthToken).toBe("sk-claude-code-from-file-xxxxxx");
  });

  it("accepts COGMO_DAYTONA_API_KEY and exposes it as `daytonaApiKey`", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_DAYTONA_API_KEY: "dtn_test_api_key_abcdef0123456789",
    });
    if (r.isErr()) throw r.error;
    expect(r.value.daytonaApiKey).toBe("dtn_test_api_key_abcdef0123456789");
  });

  it("reads COGMO_DAYTONA_API_KEY from the _FILE variant", () => {
    const path = tempFile("dtn_from_file_abcdef0123456789");
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_DAYTONA_API_KEY_FILE: path,
    });
    if (r.isErr()) throw r.error;
    expect(r.value.daytonaApiKey).toBe("dtn_from_file_abcdef0123456789");
  });

  it("rejects a too-short COGMO_DAYTONA_API_KEY", () => {
    const r = parseNonInteractiveEnv({
      COGMO_LLM_PROVIDER_TYPE: "anthropic",
      COGMO_LLM_API_KEY: "sk-ant-0123456789",
      COGMO_DAYTONA_API_KEY: "short",
    });
    if (r.isOk()) throw new Error("expected error");
    expect(r.error.issues.join("\n")).toMatch(/COGMO_DAYTONA_API_KEY/);
  });
});
