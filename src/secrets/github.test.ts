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
};

class FakeLookup implements GitHubIdentitySecretsLookup {
  #values = new Map<string, string>();
  async getSecret(name: string): Promise<string | null> {
    return this.#values.get(name) ?? null;
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
    expect(
      GitHubIdentitySchema.safeParse({ pat: VALID.pat, sshPublicKey: VALID.sshPublicKey }).success,
    ).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(GitHubIdentitySchema.safeParse({ ...VALID, extra: "nope" }).success).toBe(false);
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
