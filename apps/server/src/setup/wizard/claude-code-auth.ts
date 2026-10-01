/**
 * Wizard step: the Claude Code subscription token the coding sandboxes run
 * the CLI with.
 */

import * as p from "@clack/prompts";
import {
  CLAUDE_CODE_OAUTH_TOKEN_SECRET,
  CLAUDE_CODE_OAUTH_TOKEN_SECRET_DESCRIPTION,
} from "../../agent/coding/auth.js";
import { validateClaudeCodeOauthToken } from "../validate.js";
import { cancelGuard, type WizardDeps } from "./step.js";

export async function stepConfigureClaudeCodeAuth(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) =>
    deps.secretsStore.getSecretMeta(tx, CLAUDE_CODE_OAUTH_TOKEN_SECRET),
  );

  if (existing) {
    const action = await p.select({
      message: "Claude Code subscription token is already configured. What would you like to do?",
      options: [
        { value: "keep", label: "Keep current token" },
        { value: "replace", label: "Replace (rotate)" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
  } else {
    const proceed = await p.confirm({
      message: "Configure Claude Code subscription auth for the coding-delegation pipeline?",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  }

  p.note(
    [
      "1. On a machine with a browser, run: claude setup-token",
      "2. Complete the OAuth flow when the browser opens.",
      "3. Copy the token printed to the terminal (valid for 1 year).",
      "",
      "Requires a Claude Pro, Max, Team, or Enterprise plan.",
    ].join("\n"),
    "Where to get a Claude Code OAuth token",
  );

  const rawToken = cancelGuard(
    await p.password({
      message: "Paste your Claude Code OAuth token:",
      validate: (v) => {
        if (!v || v.trim().length < 20) return "Token looks too short";
        return undefined;
      },
    }),
  );
  // Trim — clipboard pastes routinely carry a trailing newline that would
  // corrupt the env var when injected into the sandbox.
  const token = rawToken.trim();

  const s = p.spinner();
  s.start("Validating Claude Code OAuth token...");
  const result = await validateClaudeCodeOauthToken(token);
  if (result.valid) {
    s.stop("Token validated.");
  } else {
    s.stop(`Validation failed: ${result.error}`);
    const saveAnyway = await p.confirm({ message: "Save anyway?", initialValue: false });
    if (!cancelGuard(saveAnyway)) return;
  }

  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: CLAUDE_CODE_OAUTH_TOKEN_SECRET,
      plaintext: token,
      description: CLAUDE_CODE_OAUTH_TOKEN_SECRET_DESCRIPTION,
    }),
  );
  if (result.valid) {
    await deps.runInTx((tx) => deps.secretsStore.markValidated(tx, CLAUDE_CODE_OAUTH_TOKEN_SECRET));
  }

  p.log.success("Claude Code OAuth token stored.");
}
