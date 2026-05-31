import { describe, expect, it } from "vitest";
import { compileToolMatchers } from "./tool-matchers.js";

describe("compileToolMatchers", () => {
  it("returns false for everything when no patterns are given", () => {
    const match = compileToolMatchers([]);
    expect(match("anything")).toBe(false);
    expect(match("mcp__github__create_pr")).toBe(false);
  });

  it("matches an exact tool name", () => {
    const match = compileToolMatchers(["recall"]);
    expect(match("recall")).toBe(true);
    expect(match("retain")).toBe(false);
  });

  it("matches a glob with a wildcard suffix", () => {
    const match = compileToolMatchers(["mcp__github__*"]);
    expect(match("mcp__github__create_pr")).toBe(true);
    expect(match("mcp__github__list_issues")).toBe(true);
    expect(match("mcp__linear__create_issue")).toBe(false);
  });

  it("matches a glob with a wildcard prefix", () => {
    const match = compileToolMatchers(["*_pr"]);
    expect(match("create_pr")).toBe(true);
    expect(match("close_pr")).toBe(true);
    expect(match("create_issue")).toBe(false);
  });

  it("supports mixing exact names and globs", () => {
    const match = compileToolMatchers(["recall", "mcp__github__*"]);
    expect(match("recall")).toBe(true);
    expect(match("mcp__github__list_issues")).toBe(true);
    expect(match("retain")).toBe(false);
  });

  it("supports brace expansion", () => {
    const match = compileToolMatchers(["mcp__{github,linear}__*"]);
    expect(match("mcp__github__list_issues")).toBe(true);
    expect(match("mcp__linear__create_issue")).toBe(true);
    expect(match("mcp__slack__post_message")).toBe(false);
  });

  it("is case-sensitive", () => {
    const match = compileToolMatchers(["mcp__github__*"]);
    expect(match("mcp__github__list_issues")).toBe(true);
    expect(match("mcp__GitHub__list_issues")).toBe(false);
  });
});
