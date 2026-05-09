import { describe, expect, it } from "vitest";
import { parseBackfillArgs } from "./migrations-cli.js";

describe("parseBackfillArgs", () => {
  it("rejects when first positional isn't `profile-class`", () => {
    const r = parseBackfillArgs(["foo", "--tag=general"]);
    expect(typeof r).toBe("string");
  });

  it("rejects missing --tag", () => {
    const r = parseBackfillArgs(["profile-class"]);
    expect(typeof r).toBe("string");
    if (typeof r === "string") expect(r).toContain("--tag");
  });

  it("rejects --tag with no values", () => {
    const r = parseBackfillArgs(["profile-class", "--tag="]);
    expect(typeof r).toBe("string");
    if (typeof r === "string") expect(r).toContain("non-empty");
  });

  it("parses single-tag form", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general"]);
    expect(r).toEqual({ classTags: ["general"], bankIdOverride: null });
  });

  it("parses comma-separated tags + dedupes whitespace", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general, legacy ,general"]);
    expect(r).toEqual({ classTags: ["general", "legacy"], bankIdOverride: null });
  });

  it("parses --bankId override", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general", "--bankId=user-42"]);
    expect(r).toEqual({ classTags: ["general"], bankIdOverride: "user-42" });
  });

  it("rejects unknown flags", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general", "--frob=baz"]);
    expect(typeof r).toBe("string");
    if (typeof r === "string") expect(r).toContain('Unknown argument "--frob=baz"');
  });
});
