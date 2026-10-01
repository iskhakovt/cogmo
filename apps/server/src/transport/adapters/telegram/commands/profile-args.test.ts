import { describe, expect, it } from "vitest";
import { assertKind } from "../../../../test/assertions.js";
import {
  parseScopeSpec,
  parseStreamSpec,
  splitScopeArgs,
  splitStreamArgs,
} from "./profile-args.js";

describe("parseScopeSpec", () => {
  it("empty tokens → show", () => {
    expect(parseScopeSpec([])).toEqual({ kind: "show" });
  });

  it("['clear'] (any case) → clear", () => {
    expect(parseScopeSpec(["clear"])).toEqual({ kind: "clear" });
    expect(parseScopeSpec(["CLEAR"])).toEqual({ kind: "clear" });
  });

  it("set with both keys, regardless of order", () => {
    const a = parseScopeSpec(["compartments=work,technical", "trust=first-party"]);
    const b = parseScopeSpec(["trust=first-party", "compartments=work,technical"]);
    expect(a).toEqual({
      kind: "set",
      scope: { compartments: ["work", "technical"], trust: ["first-party"] },
    });
    expect(b).toEqual(a);
  });

  it("rejects missing key (compartments only)", () => {
    const r = parseScopeSpec(["compartments=work"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Both compartments=… and trust=…");
  });

  it("rejects unknown key", () => {
    const r = parseScopeSpec(["compartments=work", "trust=any", "extra=foo"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain('Unknown key "extra"');
  });

  it("rejects token without '='", () => {
    const r = parseScopeSpec(["bogus"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain('Bad token "bogus"');
  });

  it("rejects empty value list (trust=)", () => {
    // After splitting and filtering empties, trust ends up as []. Zod's .min(1)
    // catches it — message mentions the validation issue.
    const r = parseScopeSpec(["compartments=work", "trust="]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("rejects unknown trust value (trust enum is still strict)", () => {
    const r = parseScopeSpec(["compartments=work", "trust=bogus"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("accepts an unknown compartment value at parse time (validation moved to Transport)", () => {
    // Compartments are now runtime-validated against the user's
    // `custom_compartments` registry, which the parser can't see. An
    // unknown value passes here and is rejected later by Transport with
    // a `compartment_unknown` error — keeping the parser pure of DB I/O
    // while still catching typos before they're persisted.
    const r = parseScopeSpec(["compartments=dnd-campaign", "trust=first-party"]);
    expect(r.kind).toBe("set");
    if (r.kind === "set") {
      expect(r.scope.compartments).toEqual(["dnd-campaign"]);
    }
  });

  it("accepts whitespace inside the comma-separated list (split-and-trim)", () => {
    // Telegram tokenises on whitespace before parseScopeSpec sees the input,
    // so a stray space *between* tokens splits them into separate tokens.
    // But a space *after a comma* inside a single token (e.g. when the
    // operator types "work, technical" and the shell preserves it) must be
    // tolerated — that's why we trim each value.
    const r = parseScopeSpec(["compartments=work,technical", "trust=first-party,any"]);
    expect(r).toEqual({
      kind: "set",
      scope: { compartments: ["work", "technical"], trust: ["first-party", "any"] },
    });
  });

  it("rejects case-mismatched trust values (typo guard at parser)", () => {
    // Compartments dropped this guard when the schema went runtime-dynamic
    // (the parser can't know "WORK" isn't a custom compartment); trust
    // keeps its strict enum so the case-mismatch check still fires here.
    const r = parseScopeSpec(["compartments=work", "trust=FIRST-PARTY"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("rejects same key repeated — points operator at a single comma list", () => {
    const r = parseScopeSpec(["compartments=work", "compartments=technical", "trust=any"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain('Key "compartments" repeated');
      expect(r.message).toContain("comma-separated");
    }
  });

  it("accepts classes=… as a third optional dimension", () => {
    const r = parseScopeSpec(["compartments=personal", "trust=first-party", "classes=intimate"]);
    expect(r).toEqual({
      kind: "set",
      scope: {
        compartments: ["personal"],
        trust: ["first-party"],
        profileClasses: ["intimate"],
      },
    });
  });

  it("accepts multiple comma-separated values in classes=…", () => {
    const r = parseScopeSpec([
      "compartments=personal",
      "trust=first-party",
      "classes=intimate,general",
    ]);
    if (r.kind !== "set") throw new Error(`expected set, got ${r.kind}`);
    expect(r.scope.profileClasses).toEqual(["intimate", "general"]);
  });

  it("rejects empty classes=… (Zod min(1) on the array)", () => {
    const r = parseScopeSpec(["compartments=personal", "trust=first-party", "classes="]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("rejects classes= repeated", () => {
    const r = parseScopeSpec([
      "compartments=personal",
      "trust=first-party",
      "classes=intimate",
      "classes=general",
    ]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain('Key "classes" repeated');
  });
});

describe("splitScopeArgs", () => {
  it("single-word name with no spec → name only", () => {
    expect(splitScopeArgs(["personal"])).toEqual({ name: "personal", scopeTokens: [] });
  });

  it("multi-word name with no spec → joined name, empty spec (show case)", () => {
    expect(splitScopeArgs(["my", "work", "profile"])).toEqual({
      name: "my work profile",
      scopeTokens: [],
    });
  });

  it("multi-word name + clear → joined name, ['clear']", () => {
    expect(splitScopeArgs(["my", "work", "clear"])).toEqual({
      name: "my work",
      scopeTokens: ["clear"],
    });
  });

  it("multi-word name + key=value tokens → joined name, full spec preserved", () => {
    expect(
      splitScopeArgs(["my", "profile", "compartments=work,technical", "trust=first-party"]),
    ).toEqual({
      name: "my profile",
      scopeTokens: ["compartments=work,technical", "trust=first-party"],
    });
  });

  it("case-insensitive scope-shape detection (CLEAR, Compartments=…)", () => {
    expect(splitScopeArgs(["my", "profile", "CLEAR"])).toEqual({
      name: "my profile",
      scopeTokens: ["CLEAR"],
    });
    expect(splitScopeArgs(["my", "profile", "Compartments=work", "Trust=any"])).toEqual({
      name: "my profile",
      scopeTokens: ["Compartments=work", "Trust=any"],
    });
  });

  it("treats any key=value-shape token as scope, not name (catches typos)", () => {
    // `compartment=` (singular) is a typo — it must route to the parser so
    // the operator sees "Unknown key 'compartment'" rather than having
    // the typo silently absorbed into the profile name.
    expect(splitScopeArgs(["work", "compartment=work", "trust=any"])).toEqual({
      name: "work",
      scopeTokens: ["compartment=work", "trust=any"],
    });
    // Same principle for any random key=value token.
    expect(splitScopeArgs(["work", "foo=bar"])).toEqual({
      name: "work",
      scopeTokens: ["foo=bar"],
    });
  });

  it("empty rest → empty name, empty spec", () => {
    expect(splitScopeArgs([])).toEqual({ name: "", scopeTokens: [] });
  });
});

describe("splitStreamArgs", () => {
  it("multi-word name + key=value tokens → joined name, full spec preserved", () => {
    expect(splitStreamArgs(["my", "profile", "chunk=500", "edits=off"])).toEqual({
      name: "my profile",
      streamTokens: ["chunk=500", "edits=off"],
    });
  });

  it("stream has no bare-keyword form — a profile named 'clear' is addressable", () => {
    expect(splitStreamArgs(["clear"])).toEqual({ name: "clear", streamTokens: [] });
    expect(splitStreamArgs(["clear", "chunk=500"])).toEqual({
      name: "clear",
      streamTokens: ["chunk=500"],
    });
  });

  it("empty rest → empty name, empty tokens", () => {
    expect(splitStreamArgs([])).toEqual({ name: "", streamTokens: [] });
  });
});

describe("parseStreamSpec", () => {
  it("empty → show", () => {
    expect(parseStreamSpec([])).toEqual({ kind: "show" });
  });

  it("chunk= sets only streamChunkChars", () => {
    expect(parseStreamSpec(["chunk=500"])).toEqual({
      kind: "set",
      changes: { streamChunkChars: 500 },
    });
  });

  it("edits=on/off/true/false maps to streamEdits boolean", () => {
    expect(parseStreamSpec(["edits=on"])).toEqual({
      kind: "set",
      changes: { streamEdits: true },
    });
    expect(parseStreamSpec(["edits=off"])).toEqual({
      kind: "set",
      changes: { streamEdits: false },
    });
    expect(parseStreamSpec(["edits=true"])).toEqual({
      kind: "set",
      changes: { streamEdits: true },
    });
    expect(parseStreamSpec(["edits=false"])).toEqual({
      kind: "set",
      changes: { streamEdits: false },
    });
  });

  it("both keys at once", () => {
    expect(parseStreamSpec(["chunk=500", "edits=off"])).toEqual({
      kind: "set",
      changes: { streamChunkChars: 500, streamEdits: false },
    });
  });

  it("rejects chunk outside [100, 4000] — defense in depth alongside DB CHECK", () => {
    // Pin the user-facing range copy — drifting silently from the DB
    // CHECK bounds would make the friendly error misleading.
    const low = parseStreamSpec(["chunk=50"]);
    assertKind(low, "error");
    expect(low.message).toContain("100 and 4000");
    const high = parseStreamSpec(["chunk=5000"]);
    assertKind(high, "error");
    expect(high.message).toContain("100 and 4000");
  });

  it("rejects non-integer chunk and surfaces the offending value", () => {
    const r = parseStreamSpec(["chunk=abc"]);
    assertKind(r, "error");
    expect(r.message).toContain("abc");
  });

  it("rejects unknown edits value", () => {
    const r = parseStreamSpec(["edits=maybe"]);
    assertKind(r, "error");
    expect(r.message).toContain("on|off");
  });

  it("rejects unknown key", () => {
    const r = parseStreamSpec(["foo=bar"]);
    assertKind(r, "error");
    expect(r.message).toContain("chunk");
    expect(r.message).toContain("edits");
  });

  it("rejects repeated keys", () => {
    expect(parseStreamSpec(["chunk=500", "chunk=1000"]).kind).toBe("error");
    expect(parseStreamSpec(["edits=on", "edits=off"]).kind).toBe("error");
  });

  it("rejects bare tokens (no '=')", () => {
    const r = parseStreamSpec(["foo"]);
    assertKind(r, "error");
    expect(r.message).toContain("chunk=<n>");
    expect(r.message).toContain("edits=on|off");
  });
});
