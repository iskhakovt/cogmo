/**
 * Non-interactive setup env parsing.
 *
 * Reads `COGMO_*` env vars, applies the `_FILE` convention for secrets,
 * validates shape with Zod, returns a typed answer object mirroring the
 * interactive wizard's collected inputs. The non-interactive entry point
 * and any future IaC surface converge on this shape.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { resolveEnvFile } from "../secrets/env-file.js";
import { PROVIDER_TYPES } from "./providers.js";

export { PROVIDER_BASE_URLS, PROVIDER_TYPES, type ProviderType } from "./providers.js";

const commaSeparated = z
  .string()
  .min(1)
  .transform((v, ctx) => {
    const parts = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      if (!/^\d+$/.test(p)) {
        ctx.addIssue({ code: "custom", message: `"${p}" is not a numeric Telegram user ID` });
        return z.NEVER;
      }
    }
    if (parts.length === 0) {
      ctx.addIssue({ code: "custom", message: "must list at least one user ID" });
      return z.NEVER;
    }
    return parts;
  });

/** Shape of the fully-resolved, validated non-interactive answers. */
export const NonInteractiveAnswersSchema = z
  .object({
    llmProviderType: z.enum(PROVIDER_TYPES),
    llmApiKey: z.string().min(10, { error: "API key looks too short" }),
    llmBaseUrl: z.string().url({ error: "COGMO_LLM_BASE_URL must be a valid URL" }).optional(),
    /**
     * Model id to register with the provider. Optional — when omitted, the
     * non-interactive runner falls back to the default profile's existing
     * `model` field, which preserves the legacy behaviour ("just wire the
     * provider; the seed already picked Sonnet"). Set this when adding a
     * provider for a model the seed doesn't pick (Grok, GPT-5.5, …).
     */
    llmModel: z.string().min(1).optional(),
    /**
     * Optional explicit limit overrides. Both default to `null`, in which
     * case the resolver falls through to the bundled LiteLLM snapshot →
     * conservative default. Set when LiteLLM doesn't know the model and
     * the conservative default (128k/4k) would compact too aggressively.
     */
    llmContextWindow: z.coerce.number().int().positive().optional(),
    llmMaxOutputTokens: z.coerce.number().int().positive().optional(),
    telegramBotToken: z
      .string()
      .regex(/:/, { error: "Telegram token must contain a colon" })
      .optional(),
    telegramAllowedUsers: commaSeparated.optional(),
    tavilyApiKey: z.string().min(10).optional(),
    falApiKey: z.string().min(10).optional(),
    githubPat: z.string().min(20).optional(),
    /** Pre-generated OpenSSH-armored Ed25519 private key. When omitted but
     * `githubPat` is set, the runner generates a fresh keypair and prints
     * the public key for the operator to install on github.com. */
    githubSshPrivateKey: z.string().min(1).optional(),
    /** Long-lived OAuth token from `claude setup-token`, injected into the
     * coding sandbox as `CLAUDE_CODE_OAUTH_TOKEN`. Optional — omit when
     * the coding-delegation pipeline isn't being wired up. */
    claudeCodeOauthToken: z.string().min(20).optional(),
    /** Daytona managed-sandbox API key. Required when `SANDBOX_BACKEND=daytona`;
     * the runtime warns and disables the sandbox if missing. `DAYTONA_API_URL`
     * and `DAYTONA_ORGANIZATION_ID` stay in the runtime env (they're plain
     * config, not credentials) — surfaced here only as the encrypted secret. */
    daytonaApiKey: z.string().min(20, { error: "Daytona API key looks too short" }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.llmProviderType === "custom" && !v.llmBaseUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["llmBaseUrl"],
        message: "COGMO_LLM_BASE_URL is required when COGMO_LLM_PROVIDER_TYPE=custom",
      });
    }
    if (v.telegramBotToken && !v.telegramAllowedUsers) {
      ctx.addIssue({
        code: "custom",
        path: ["telegramAllowedUsers"],
        message:
          "COGMO_TELEGRAM_ALLOWED_USERS is required when COGMO_TELEGRAM_BOT_TOKEN is provided",
      });
    }
    if (v.telegramAllowedUsers && !v.telegramBotToken) {
      ctx.addIssue({
        code: "custom",
        path: ["telegramBotToken"],
        message:
          "COGMO_TELEGRAM_BOT_TOKEN is required when COGMO_TELEGRAM_ALLOWED_USERS is provided",
      });
    }
  });

export type NonInteractiveAnswers = z.infer<typeof NonInteractiveAnswersSchema>;

/** Env var names that support the `_FILE` convention. */
const FILE_BACKED = [
  "COGMO_LLM_API_KEY",
  "COGMO_TELEGRAM_BOT_TOKEN",
  "COGMO_TAVILY_API_KEY",
  "COGMO_FAL_API_KEY",
  "COGMO_GITHUB_PAT",
  "COGMO_GITHUB_SSH_PRIVATE_KEY",
  "COGMO_CLAUDE_CODE_OAUTH_TOKEN",
  "COGMO_DAYTONA_API_KEY",
] as const;

/** Plain env var names (no `_FILE` variant, value used as-is). */
const PLAIN = [
  "COGMO_LLM_PROVIDER_TYPE",
  "COGMO_LLM_BASE_URL",
  "COGMO_LLM_MODEL",
  "COGMO_LLM_CONTEXT_WINDOW",
  "COGMO_LLM_MAX_OUTPUT_TOKENS",
  "COGMO_TELEGRAM_ALLOWED_USERS",
] as const;

export class SetupEnvError extends Error {
  readonly issues: ReadonlyArray<string>;
  constructor(issues: ReadonlyArray<string>) {
    super(`Invalid non-interactive setup env:\n  - ${issues.join("\n  - ")}`);
    this.name = "SetupEnvError";
    this.issues = issues;
  }
}

/**
 * Resolve the full env block (applying `_FILE` for secret inputs), then
 * validate against the Zod schema.
 *
 * Returns `Result` at the boundary — callers decide how to surface errors.
 * File I/O (for `_FILE` lookups) can throw; we catch and wrap those as well.
 */
export function parseNonInteractiveEnv(
  envObj: Record<string, string | undefined>,
): Result<NonInteractiveAnswers, SetupEnvError> {
  const resolved: Record<string, string | undefined> = {};

  try {
    for (const name of FILE_BACKED) {
      resolved[name] = resolveEnvFile(envObj, name);
    }
  } catch (e) {
    return err(new SetupEnvError([`Failed to read _FILE secret: ${(e as Error).message}`]));
  }

  for (const name of PLAIN) {
    resolved[name] = envObj[name];
  }

  // Surface missing-required before Zod so the message names the env var,
  // not the internal field name.
  const missing: string[] = [];
  if (!resolved.COGMO_LLM_PROVIDER_TYPE) missing.push("COGMO_LLM_PROVIDER_TYPE");
  if (!resolved.COGMO_LLM_API_KEY) missing.push("COGMO_LLM_API_KEY (or COGMO_LLM_API_KEY_FILE)");
  if (missing.length > 0) {
    return err(new SetupEnvError(missing.map((m) => `${m} is required`)));
  }

  const parsed = NonInteractiveAnswersSchema.safeParse({
    llmProviderType: resolved.COGMO_LLM_PROVIDER_TYPE,
    llmApiKey: resolved.COGMO_LLM_API_KEY,
    llmBaseUrl: resolved.COGMO_LLM_BASE_URL,
    llmModel: resolved.COGMO_LLM_MODEL,
    llmContextWindow: resolved.COGMO_LLM_CONTEXT_WINDOW,
    llmMaxOutputTokens: resolved.COGMO_LLM_MAX_OUTPUT_TOKENS,
    telegramBotToken: resolved.COGMO_TELEGRAM_BOT_TOKEN,
    telegramAllowedUsers: resolved.COGMO_TELEGRAM_ALLOWED_USERS,
    tavilyApiKey: resolved.COGMO_TAVILY_API_KEY,
    falApiKey: resolved.COGMO_FAL_API_KEY,
    githubPat: resolved.COGMO_GITHUB_PAT,
    githubSshPrivateKey: resolved.COGMO_GITHUB_SSH_PRIVATE_KEY,
    claudeCodeOauthToken: resolved.COGMO_CLAUDE_CODE_OAUTH_TOKEN,
    daytonaApiKey: resolved.COGMO_DAYTONA_API_KEY,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const envName = fieldToEnv(i.path[0]);
      return `${envName}: ${i.message}`;
    });
    return err(new SetupEnvError(issues));
  }

  return ok(parsed.data);
}

const FIELD_TO_ENV: Record<string, string> = {
  llmProviderType: "COGMO_LLM_PROVIDER_TYPE",
  llmApiKey: "COGMO_LLM_API_KEY",
  llmBaseUrl: "COGMO_LLM_BASE_URL",
  telegramBotToken: "COGMO_TELEGRAM_BOT_TOKEN",
  telegramAllowedUsers: "COGMO_TELEGRAM_ALLOWED_USERS",
  tavilyApiKey: "COGMO_TAVILY_API_KEY",
  falApiKey: "COGMO_FAL_API_KEY",
  githubPat: "COGMO_GITHUB_PAT",
  githubSshPrivateKey: "COGMO_GITHUB_SSH_PRIVATE_KEY",
  claudeCodeOauthToken: "COGMO_CLAUDE_CODE_OAUTH_TOKEN",
  daytonaApiKey: "COGMO_DAYTONA_API_KEY",
};

function fieldToEnv(field: unknown): string {
  return typeof field === "string" && field in FIELD_TO_ENV
    ? (FIELD_TO_ENV[field] ?? String(field))
    : "setup";
}
