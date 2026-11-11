import { describe, expect, it } from "vitest";
import { PATHS_CASES } from "../../test/gates-cases.js";
import { describeLocateSkillRejection, skillOfChangedPaths } from "./locate-skill.js";

describe("skillOfChangedPaths: the parity table, as register applies it", () => {
  it.each(PATHS_CASES)("$label", ({ paths, lines, exit }) => {
    const outcome = skillOfChangedPaths(paths).match(
      () => ({ exit: 0, lines: [] }),
      (rejection) => ({ exit: 1, lines: [describeLocateSkillRejection(rejection)] }),
    );
    expect(outcome).toEqual({ exit, lines });
  });
});

describe("skillOfChangedPaths", () => {
  it("names the one skill a change touches", () => {
    expect(
      skillOfChangedPaths([
        "skills/echo/skill.py",
        "skills/echo/requirements.lock",
      ])._unsafeUnwrap(),
    ).toEqual({ kind: "one", name: "echo" });
  });

  it("names none for no paths, leaving the tip to name it", () => {
    expect(skillOfChangedPaths([])._unsafeUnwrap()).toEqual({ kind: "none" });
  });

  it("lists every path outside a skill's own files, in the change's order", () => {
    expect(
      skillOfChangedPaths([
        "notes.md",
        "skills/echo/skill.py",
        "skills/echo/data/x.json",
      ])._unsafeUnwrapErr(),
    ).toEqual({ kind: "outside_paths", paths: ["notes.md", "skills/echo/data/x.json"] });
  });
});
