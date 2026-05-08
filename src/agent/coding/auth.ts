/**
 * Claude Code subscription auth — secret-store key plus the helper that
 * lifts the OAuth token into the per-task sandbox env.
 *
 * See design/coding-delegation.md → Subscription Auth for the rationale
 * (long-lived `CLAUDE_CODE_OAUTH_TOKEN` injected at container create time;
 * never written to the home volume).
 */

import { err, ok, type Result } from "neverthrow";
import type { Transaction } from "../../db/index.js";
import type { SecretsStore } from "../../secrets/store/index.js";

export const CLAUDE_CODE_OAUTH_TOKEN_SECRET = "claude_code_oauth_token";

export const CLAUDE_CODE_OAUTH_TOKEN_SECRET_DESCRIPTION =
  "Claude Code subscription OAuth token (output of `claude setup-token`)";

/** Discriminated failure for `loadCodingSandboxEnv`. */
export type LoadCodingSandboxEnvError = {
  kind: "missing_oauth_token";
  /** Operator-actionable message naming the rotation ritual. */
  message: string;
};

/**
 * Resolve the env map injected into the coding sandbox via `SessionSpec.env`.
 * Returns a single-entry record today; keyed return shape so future auth
 * additions (Codex, proxy hints) drop in without touching callers.
 *
 * Returns `Result.err` (rather than throwing) when the OAuth token secret
 * is missing — missing-secret is an expected, user-actionable failure
 * mode, so the orchestrator routes it through its fail-and-teardown path
 * instead of bubbling as an unhandled exception.
 */
export async function loadCodingSandboxEnv(
  tx: Transaction,
  secretsStore: SecretsStore,
): Promise<Result<Record<string, string>, LoadCodingSandboxEnvError>> {
  const oauth = await secretsStore.getSecret(tx, CLAUDE_CODE_OAUTH_TOKEN_SECRET);
  if (!oauth) {
    return err({
      kind: "missing_oauth_token",
      message:
        `Claude Code subscription auth missing — secret "${CLAUDE_CODE_OAUTH_TOKEN_SECRET}" is not set. ` +
        "Run `claude setup-token` on a machine with a browser, then re-run `cogmo setup` " +
        "and paste the token when prompted (see design/coding-delegation.md → Subscription Auth).",
    });
  }
  return ok({ CLAUDE_CODE_OAUTH_TOKEN: oauth });
}
