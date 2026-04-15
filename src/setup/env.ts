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
    telegramBotToken: z
      .string()
      .regex(/:/, { error: "Telegram token must contain a colon" })
      .optional(),
    telegramAllowedUsers: commaSeparated.optional(),
    tavilyApiKey: z.string().min(10).optional(),
    falApiKey: z.string().min(10).optional(),
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
] as const;

/** Plain env var names (no `_FILE` variant, value used as-is). */
const PLAIN = [
  "COGMO_LLM_PROVIDER_TYPE",
  "COGMO_LLM_BASE_URL",
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
    telegramBotToken: resolved.COGMO_TELEGRAM_BOT_TOKEN,
    telegramAllowedUsers: resolved.COGMO_TELEGRAM_ALLOWED_USERS,
    tavilyApiKey: resolved.COGMO_TAVILY_API_KEY,
    falApiKey: resolved.COGMO_FAL_API_KEY,
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
};

function fieldToEnv(field: unknown): string {
  return typeof field === "string" && field in FIELD_TO_ENV
    ? (FIELD_TO_ENV[field] ?? String(field))
    : "setup";
}
