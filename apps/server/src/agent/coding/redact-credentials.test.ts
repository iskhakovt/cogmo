import { describe, expect, it } from "vitest";
import { redactCredentials } from "./redact-credentials.js";

describe("redactCredentials", () => {
  it("masks URL userinfo and keeps the scheme, host and path", () => {
    expect(
      redactCredentials(
        "fatal: unable to access 'https://x-access-token:s3cr:et@github.com/o/r.git/'",
      ),
    ).toBe("fatal: unable to access 'https://***:***@github.com/o/r.git/'");
    expect(redactCredentials("http://u:p@host:8080/a and HTTPS://u:p@host/b")).toBe(
      "http://***:***@host:8080/a and HTTPS://***:***@host/b",
    );
  });

  it.each(["ghp", "gho", "ghu", "ghs", "ghr", "github_pat"])("replaces %s_ tokens", (prefix) => {
    const token = `${prefix}_${"A1b2_".repeat(8)}`;
    expect(redactCredentials(`GH_TOKEN=${token} then https://${token}@github.com/o/r`)).toBe(
      "GH_TOKEN=<REDACTED> then https://<REDACTED>@github.com/o/r",
    );
  });

  it("leaves text without credentials unchanged", () => {
    const text = [
      "To git@github.com:o/r.git",
      " ! [rejected]        cogmo/abc -> cogmo/abc (non-fast-forward)",
      "remote: https://github.com/o/r/pull/new/cogmo/abc",
      "ssh://git@github.com/o/r.git, https://github.com:443/o/r, mail user@example.com",
      "see https://github.com: denied for user@example.com",
      "laughs_at_a_long_snake_case_identifier, ghp_short",
    ].join("\n");
    expect(redactCredentials(text)).toBe(text);
  });
});
