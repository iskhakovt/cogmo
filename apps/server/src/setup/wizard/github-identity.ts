/**
 * Wizard step: the GitHub identity the coding pipeline pushes and signs as —
 * a PAT plus a locally generated SSH signing key.
 */

import * as p from "@clack/prompts";
import {
  DEFAULT_GITHUB_IDENTITY_NAME,
  type GitHubIdentity,
  gitHubIdentitySecretName,
  resolveGitHubIdentity,
  serializeGitHubIdentity,
} from "../../secrets/github.js";
import { generateSshKeyPair } from "../../secrets/ssh-keygen.js";
import { validateGitHubPat } from "../validate.js";
import { cancelGuard, type WizardDeps } from "./step.js";

export async function stepConfigureGitHubIdentity(deps: WizardDeps): Promise<void> {
  const existing = await deps.runInTx((tx) =>
    resolveGitHubIdentity(tx, deps.secretsStore, DEFAULT_GITHUB_IDENTITY_NAME),
  );

  if (existing.isOk()) {
    const ident = existing.value;
    const action = await p.select({
      message: `GitHub identity '${DEFAULT_GITHUB_IDENTITY_NAME}' is already configured. What would you like to do?`,
      options: [
        { value: "keep", label: "Keep current configuration" },
        { value: "replace", label: "Replace PAT (re-uses existing signing key)" },
        { value: "regenerate", label: "Replace PAT and generate a new signing key" },
      ],
    });
    cancelGuard(action);
    if (action === "keep") return;
    if (action === "replace") {
      await collectAndStorePat(deps, ident);
      return;
    }
    // fall-through to full re-provision
  } else if (existing.error.code !== "missing") {
    // Stored identity exists but doesn't parse — most likely a hand-edited
    // secrets row. Confirm before overwriting; the operator may want to
    // bail out and inspect the row first rather than letting the wizard
    // silently replace it with a fresh PAT + keypair.
    p.log.warn(`Existing GitHub identity could not be parsed (${existing.error.code}).`);
    const proceed = await p.confirm({
      message: "Replace it with a fresh PAT + signing keypair?",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  } else {
    const proceed = await p.confirm({
      message: "Configure a GitHub identity for the coding-delegation pipeline? (optional)",
      initialValue: false,
    });
    if (!cancelGuard(proceed)) return;
  }

  p.note(
    [
      "1. Create a fine-grained PAT at https://github.com/settings/personal-access-tokens/new",
      "2. Resource owner: pick the bot account or org that should author PRs.",
      "3. Repository access: select the repos you'll register with `/repo add`.",
      "4. Permissions: Contents (Read & write), Pull requests (Read & write), Metadata (Read).",
    ].join("\n"),
    "Where to get a GitHub PAT",
  );

  const pat = cancelGuard(
    await p.password({
      message: "Paste your GitHub PAT:",
      validate: (v) => {
        if (!v || v.length < 20) return "PAT looks too short";
        return undefined;
      },
    }),
  );

  const s = p.spinner();
  s.start("Validating GitHub PAT...");
  const result = await validateGitHubPat(pat);
  if (!result.valid) {
    s.stop(`Validation failed: ${result.error ?? "unknown error"}`);
    p.log.warn("Skipping GitHub identity. Re-run `cogmo setup` to try again.");
    return;
  }
  // login + id come from `GET /user`; both are required by the schema.
  // `validateGitHubPat` already short-circuits with `valid:false` when
  // either is absent, so by here we trust them.
  const login = result.meta?.login ?? "";
  const userId = result.meta?.id ?? "";
  if (!login || !userId) {
    s.stop("Validation succeeded but `login`/`id` were missing — aborting.");
    return;
  }
  s.stop(`PAT validated as @${login} (id ${userId}).`);

  const keys = generateSshKeyPair(`cogmo-bot@${login}`);

  const identity: GitHubIdentity = {
    pat,
    sshPrivateKey: keys.privateKey,
    sshPublicKey: keys.publicKey,
    login,
    id: userId,
  };

  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME),
      plaintext: serializeGitHubIdentity(identity),
      description: `GitHub identity (@${login})`,
    }),
  );
  await deps.runInTx((tx) =>
    deps.secretsStore.markValidated(tx, gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME)),
  );

  p.note(
    [
      "Add this as a *signing key* (not authentication) on the bot account:",
      "  https://github.com/settings/ssh/new",
      "",
      `Public key (${keys.fingerprint}):`,
      keys.publicKey,
    ].join("\n"),
    "Install the SSH signing key",
  );

  cancelGuard(
    await p.confirm({
      message: "Press Enter once you've installed the signing key on github.com.",
      initialValue: true,
    }),
  );

  p.log.success(`GitHub identity '${DEFAULT_GITHUB_IDENTITY_NAME}' stored.`);
}

async function collectAndStorePat(deps: WizardDeps, existing: GitHubIdentity): Promise<void> {
  const pat = cancelGuard(
    await p.password({
      message: "Paste the new GitHub PAT:",
      validate: (v) => {
        if (!v || v.length < 20) return "PAT looks too short";
        return undefined;
      },
    }),
  );

  const s = p.spinner();
  s.start("Validating GitHub PAT...");
  const result = await validateGitHubPat(pat);
  if (!result.valid) {
    s.stop(`Validation failed: ${result.error ?? "unknown error"}`);
    p.log.warn("Keeping the previous PAT.");
    return;
  }
  const login = result.meta?.login ?? "";
  const userId = result.meta?.id ?? "";
  if (!login || !userId) {
    s.stop("Validation succeeded but `login`/`id` were missing — keeping the previous PAT.");
    return;
  }
  // Reject a PAT that authenticates as a different account — the existing
  // signing key wouldn't match, so commit signatures would show "Unverified"
  // on github.com. The operator should pick "Regenerate" instead.
  if (existing.login !== login) {
    s.stop(
      `New PAT authenticates as @${login}, but the stored signing key is for @${existing.login}. Run "Regenerate" to rotate both together.`,
    );
    return;
  }
  s.stop(`PAT validated as @${login}.`);

  const identity: GitHubIdentity = {
    pat,
    sshPrivateKey: existing.sshPrivateKey,
    sshPublicKey: existing.sshPublicKey,
    login,
    id: userId,
  };

  await deps.runInTx((tx) =>
    deps.secretsStore.putSecret(tx, {
      name: gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME),
      plaintext: serializeGitHubIdentity(identity),
      description: `GitHub identity (@${login})`,
    }),
  );
  await deps.runInTx((tx) =>
    deps.secretsStore.markValidated(tx, gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME)),
  );
  p.log.success("GitHub PAT rotated.");
}
