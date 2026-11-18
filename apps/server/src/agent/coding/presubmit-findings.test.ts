import { describe, expect, it } from "vitest";
import { fitFindings, splitFindings } from "./presubmit-findings.js";

const FINDINGS = ["ruff: a.py:1:1: E501", "ruff: a.py:2:1: E501", "pyrefly: a.py:3:1: bad-return"];
const within = (cap: number) => (text: string) => text.length <= cap;

describe("fitFindings", () => {
  it("keeps every finding, one per line, when they fit", () => {
    expect(fitFindings(FINDINGS, within(1_000))).toBe(FINDINGS.join("\n"));
  });

  it("cuts at a finding boundary and counts the rest", () => {
    const cap = `${FINDINGS[0]}\n[2 more findings]`.length;

    expect(fitFindings(FINDINGS, within(cap))).toBe(`${FINDINGS[0]}\n[2 more findings]`);
    expect(fitFindings(FINDINGS, within(cap - 1))).toBe("[3 more findings]");
  });

  it("adds the count an earlier cut left to the ones it leaves out", () => {
    const cut = [...FINDINGS, "[5 more findings]"];

    expect(fitFindings(cut, within(1_000))).toBe(cut.join("\n"));
    expect(fitFindings(cut, within(`${FINDINGS[0]}\n[7 more findings]`.length))).toBe(
      `${FINDINGS[0]}\n[7 more findings]`,
    );
  });

  it("comes back as the count when not even the count fits, and empty with nothing to say", () => {
    expect(fitFindings(FINDINGS, within(3))).toBe("[3 more findings]");
    expect(fitFindings([], within(0))).toBe("");
  });

  it("keeps a finding's own line breaks inside it, so the text splits back into the same findings", () => {
    const resolver = "requirements_lock_resolver_failed: no solution\n  because x\nand y";
    const findings = [resolver, "ruff: a.py:1:1: E501"];
    const text = fitFindings(findings, within(1_000));

    expect(splitFindings(text)).toEqual(findings);
    // Room for the indented finding and the count, not for both findings.
    const cut = fitFindings(splitFindings(text), within(resolver.length + 23));
    expect(splitFindings(cut)).toEqual([resolver, "[1 more findings]"]);
  });

  it("counts the skills image's per-check tail, which names the file, as its findings", () => {
    const findings = [
      "ruff: skills/echo/skill.py:1:1: E501",
      "ruff: skills/echo/skill.py: and 20 more ruff findings",
    ];

    expect(fitFindings(findings, within(`${findings[0]}\n[20 more findings]`.length))).toBe(
      `${findings[0]}\n[20 more findings]`,
    );
  });

  it("counts a per-check tail it leaves out as the findings it stands for", () => {
    const findings = [
      "ruff: a.py:1:1: E501",
      "ruff: and 20 more ruff findings",
      "pyrefly: and 3 more pyrefly findings",
    ];

    expect(fitFindings(findings, within(`${findings[0]}\n[23 more findings]`.length))).toBe(
      `${findings[0]}\n[23 more findings]`,
    );
  });
});
