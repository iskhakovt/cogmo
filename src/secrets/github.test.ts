import { describe, expect, it } from "vitest";
import {
  DEFAULT_GITHUB_IDENTITY_NAME,
  describeResolveIdentityError,
  type GitHubIdentity,
  GitHubIdentitySchema,
  type GitHubIdentitySecretsLookup,
  gitHubIdentitySecretName,
  resolveGitHubIdentity,
  resolveGitHubIdentityForRepo,
  serializeGitHubIdentity,
} from "./github.js";

const VALID: GitHubIdentity = {
  pat: "ghp_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  sshPrivateKey:
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...AAAA\n-----END OPENSSH PRIVATE KEY-----",
  sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK... cogmo-bot",
  login: "cogmo-bot",
  id: "12345",
};

class FakeLookup implements GitHubIdentitySecretsLookup {
  #values = new Map<string, string>();
  async getSecret(name: string): Promise<string | undefined> {
    return this.#values.get(name);
  }
  set(name: string, value: string): void {
    this.#values.set(name, value);
  }
}

describe("gitHubIdentitySecretName", () => {
  it("namespaces the identity under the github_identity prefix", () => {
    expect(gitHubIdentitySecretName("default")).toBe("github_identity:default");
    expect(gitHubIdentitySecretName("acme-bot")).toBe("github_identity:acme-bot");
  });

  it("DEFAULT_GITHUB_IDENTITY_NAME is the conventional default", () => {
    expect(DEFAULT_GITHUB_IDENTITY_NAME).toBe("default");
    expect(gitHubIdentitySecretName(DEFAULT_GITHUB_IDENTITY_NAME)).toBe("github_identity:default");
  });
});

describe("GitHubIdentitySchema", () => {
  it("accepts a complete bundle", () => {
    expect(GitHubIdentitySchema.safeParse(VALID).success).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(GitHubIdentitySchema.safeParse({ ...VALID, pat: undefined }).success).toBe(false);
    expect(GitHubIdentitySchema.safeParse({ ...VALID, sshPrivateKey: "" }).success).toBe(false);
    expect(GitHubIdentitySchema.safeParse({ ...VALID, login: undefined }).success).toBe(false);
    expect(GitHubIdentitySchema.safeParse({ ...VALID, id: undefined }).success).toBe(false);
    expect(
      GitHubIdentitySchema.safeParse({ pat: VALID.pat, sshPublicKey: VALID.sshPublicKey }).success,
    ).toBe(false);
  });

  it("rejects non-numeric id", () => {
    expect(GitHubIdentitySchema.safeParse({ ...VALID, id: "not-a-number" }).success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(GitHubIdentitySchema.safeParse({ ...VALID, extra: "nope" }).success).toBe(false);
  });

  it("rejects each required field individually when missing, with that field on the issue path", () => {
    // Build an explicit list of required fields rather than looping over keys —
    // a regression that drops one of these from the schema should fail loudly,
    // and grepping for the field name should land here.
    const requiredFields: ReadonlyArray<keyof GitHubIdentity> = [
      "pat",
      "sshPrivateKey",
      "sshPublicKey",
      "login",
      "id",
    ];
    for (const field of requiredFields) {
      const { [field]: _omitted, ...rest } = VALID;
      const result = GitHubIdentitySchema.safeParse(rest);
      expect(result.success, `expected missing '${field}' to fail parse`).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
      }
    }
  });

  it("rejects each required string field when set to the empty string", () => {
    // `.min(1)` on every string field — empty string is not a stand-in for "absent".
    const stringFields: ReadonlyArray<keyof GitHubIdentity> = [
      "pat",
      "sshPrivateKey",
      "sshPublicKey",
      "login",
    ];
    for (const field of stringFields) {
      const result = GitHubIdentitySchema.safeParse({ ...VALID, [field]: "" });
      expect(result.success, `expected empty '${field}' to fail parse`).toBe(false);
    }
  });

  it("rejects an `id` that is empty, signed, decimal, hex, or otherwise non-digits", () => {
    const badIds = ["", "-1", "1.5", "0x1f", "12345 ", " 12345", "12 345", "abc", "1e3"];
    for (const id of badIds) {
      const result = GitHubIdentitySchema.safeParse({ ...VALID, id });
      expect(result.success, `expected id='${id}' to fail parse`).toBe(false);
    }
  });

  it("accepts arbitrary digit strings for `id` (including leading zeros and very long ids)", () => {
    // The regex is `^\d+$` — no length cap, no leading-zero rule. Pin that.
    for (const id of ["0", "00", "01", "1", "999999999999999999999"]) {
      expect(GitHubIdentitySchema.safeParse({ ...VALID, id }).success).toBe(true);
    }
  });

  // The schema deliberately does NOT enforce GitHub-specific formats on the
  // PAT or the SSH keypair. Capturing/validating those formats is the job of
  // the setup wizard (where the operator can be re-prompted with a useful
  // message); the storage schema just guards "non-empty string". These tests
  // pin that contract — bumping validation stricter would break them on
  // purpose, forcing a deliberate decision.
  it("does not enforce a GitHub PAT prefix — any non-empty string is accepted", () => {
    for (const pat of [
      "ghp_realLookingButFake",
      "github_pat_realLookingButFake",
      "ghs_serverToken",
      "no-prefix-at-all",
      "totally bogus value with spaces",
      "x", // single char, still passes min(1)
    ]) {
      expect(
        GitHubIdentitySchema.safeParse({ ...VALID, pat }).success,
        `expected pat='${pat}' to pass`,
      ).toBe(true);
    }
  });

  it("does not enforce an OpenSSH public-key format — any non-empty string is accepted", () => {
    for (const sshPublicKey of [
      "ssh-ed25519 AAAAC3Nz... cogmo-bot", // well-formed
      "ssh-rsa AAAAB3Nz... cogmo-bot", // well-formed (other algo)
      "not-a-key",
      "AAAAC3NzaC1lZDI1NTE5AAAAIK...", // base64 alone, no algo prefix
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----", // PEM, not OpenSSH
    ]) {
      expect(
        GitHubIdentitySchema.safeParse({ ...VALID, sshPublicKey }).success,
        `expected sshPublicKey='${sshPublicKey.slice(0, 32)}...' to pass`,
      ).toBe(true);
    }
  });

  it("does not enforce OpenSSH armor on the private key — truncated/missing armor is accepted", () => {
    for (const sshPrivateKey of [
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn...\n-----END OPENSSH PRIVATE KEY-----", // well-formed
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn...", // truncated end armor
      "b3BlbnNzaC1rZXktdjEAAAAA...", // raw base64, no armor at all
      "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----", // wrong armor type (PEM RSA, not OpenSSH)
      "garbage",
    ]) {
      expect(
        GitHubIdentitySchema.safeParse({ ...VALID, sshPrivateKey }).success,
        `expected sshPrivateKey='${sshPrivateKey.slice(0, 32)}...' to pass`,
      ).toBe(true);
    }
  });
});

describe("serializeGitHubIdentity", () => {
  it("round-trips through JSON", () => {
    const s = serializeGitHubIdentity(VALID);
    expect(JSON.parse(s)).toEqual(VALID);
  });

  it("rejects malformed input via Zod parse", () => {
    expect(() => serializeGitHubIdentity({ ...VALID, pat: "" })).toThrow();
  });
});

describe("resolveGitHubIdentity", () => {
  it("returns the parsed bundle when present and well-formed", async () => {
    const lookup = new FakeLookup();
    lookup.set("github_identity:default", JSON.stringify(VALID));

    const result = await resolveGitHubIdentity(lookup, "default");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(VALID);
  });

  it("returns `missing` when the identity is not installed", async () => {
    const lookup = new FakeLookup();
    const result = await resolveGitHubIdentity(lookup, "default");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe("missing");
    if (error.code === "missing") expect(error.identityName).toBe("default");
  });

  it("returns `malformed_json` when the stored secret is not JSON", async () => {
    const lookup = new FakeLookup();
    lookup.set("github_identity:default", "this is not json {");
    const result = await resolveGitHubIdentity(lookup, "default");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("malformed_json");
  });

  it("returns `schema_mismatch` when JSON is well-formed but the shape is wrong", async () => {
    const lookup = new FakeLookup();
    lookup.set("github_identity:default", JSON.stringify({ pat: "x", sshPrivateKey: "" }));
    const result = await resolveGitHubIdentity(lookup, "default");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe("schema_mismatch");
    if (error.code === "schema_mismatch") expect(error.issues.length).toBeGreaterThan(0);
  });

  it("disambiguates identities by name", async () => {
    const lookup = new FakeLookup();
    const acme: GitHubIdentity = { ...VALID, pat: "ghp_acme_xxxxxxxxxxxxxxx" };
    lookup.set("github_identity:default", JSON.stringify(VALID));
    lookup.set("github_identity:acme", JSON.stringify(acme));

    const def = await resolveGitHubIdentity(lookup, "default");
    const ac = await resolveGitHubIdentity(lookup, "acme");
    expect(def._unsafeUnwrap().pat).toBe(VALID.pat);
    expect(ac._unsafeUnwrap().pat).toBe(acme.pat);
  });
});

describe("resolveGitHubIdentityForRepo", () => {
  it("uses the repo's identity_name to pick which row to read", async () => {
    const lookup = new FakeLookup();
    const acme: GitHubIdentity = { ...VALID, pat: "ghp_acme_xxxxxxxxxxxxxxx" };
    lookup.set("github_identity:default", JSON.stringify(VALID));
    lookup.set("github_identity:acme-bot", JSON.stringify(acme));

    const defaultRepo = await resolveGitHubIdentityForRepo(lookup, { identityName: "default" });
    const acmeRepo = await resolveGitHubIdentityForRepo(lookup, { identityName: "acme-bot" });

    expect(defaultRepo._unsafeUnwrap().pat).toBe(VALID.pat);
    expect(acmeRepo._unsafeUnwrap().pat).toBe(acme.pat);
  });

  it("does NOT fall back to default when the per-repo identity is missing", async () => {
    // The fall-back semantics belong in the orchestrator if we ever want them;
    // the resolver answers exactly the question it was asked. This keeps the
    // misconfiguration surface narrow — a typo in `identity_name` fails loudly
    // rather than silently authoring PRs under the wrong account.
    const lookup = new FakeLookup();
    lookup.set("github_identity:default", JSON.stringify(VALID));
    const result = await resolveGitHubIdentityForRepo(lookup, { identityName: "missing" });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe("missing");
    if (error.code === "missing") expect(error.identityName).toBe("missing");
  });
});

describe("describeResolveIdentityError", () => {
  it("formats each error variant for operator display", () => {
    expect(describeResolveIdentityError({ code: "missing", identityName: "default" })).toMatch(
      /not configured/i,
    );
    expect(
      describeResolveIdentityError({ code: "malformed_json", identityName: "default" }),
    ).toMatch(/not valid JSON/i);
    expect(
      describeResolveIdentityError({
        code: "schema_mismatch",
        identityName: "default",
        issues: [{ code: "custom", message: "boom", path: [] }],
      }),
    ).toMatch(/malformed/i);
  });
});
