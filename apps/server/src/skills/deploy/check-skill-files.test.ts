import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertKind, expectDefined } from "../../test/assertions.js";
import { DEPENDENCIES_CASES, GATES_CASES } from "../../test/gates-cases.js";
import { useVendoredPythonGrammar } from "../../test/skills-fixtures.js";
import { BUILD_CAPABILITIES } from "../capabilities.js";
import { configurePythonParser } from "../python-parser.js";
import { checkSkillFiles, declaredDependencyNames } from "./check-skill-files.js";

const PASSING = expectDefined(
  GATES_CASES.find((c) => c.exit === 0),
  "a passing case",
);

beforeAll(useVendoredPythonGrammar);

describe("checkSkillFiles: the parity table, as register calls it", () => {
  it.each(GATES_CASES)("$label", async ({ name, manifest, body, lines, exit }) => {
    const checked = await checkSkillFiles(name, { manifest, body }, BUILD_CAPABILITIES);

    const outcome = checked.match(
      () => ({ exit: 0, lines: [] }),
      (rejection) => {
        assertKind(rejection, "refused");
        return { exit: 1, lines: rejection.errors };
      },
    );
    expect(outcome).toEqual({ exit, lines });
  });
});

describe("checkSkillFiles", () => {
  afterEach(useVendoredPythonGrammar);

  it("returns the parsed manifest, the body and the classifier's log for a pass", async () => {
    const files = { manifest: PASSING.manifest, body: PASSING.body };

    const checked = (await checkSkillFiles("echo", files, BUILD_CAPABILITIES))._unsafeUnwrap();

    expect(checked.manifest.name).toBe("echo");
    expect(checked.body).toBe(files.body);
    expect(checked.classifierLog.validation_errors).toEqual([]);
  });

  it("pauses as registrar_unavailable when the grammar cannot load, past the earlier stages", async () => {
    const missing = join(tmpdir(), "cogmo-check-skill-files-no-grammar.wasm");
    configurePythonParser(missing);

    const checked = await checkSkillFiles(
      "echo",
      { manifest: PASSING.manifest, body: PASSING.body },
      BUILD_CAPABILITIES,
    );

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "registrar_unavailable",
      cause: "parser",
      detail: expect.stringContaining(`the Python grammar at ${missing} did not load`),
    });
  });

  it("refuses a missing file before it needs the grammar", async () => {
    configurePythonParser(join(tmpdir(), "cogmo-check-skill-files-no-grammar.wasm"));

    const checked = await checkSkillFiles(
      "echo",
      { manifest: PASSING.manifest, body: null },
      BUILD_CAPABILITIES,
    );

    expect(checked._unsafeUnwrapErr()).toEqual({
      kind: "refused",
      errors: ["missing_skill_py: skills/echo/skill.py not found"],
    });
  });
});

describe("declaredDependencyNames: the parity table", () => {
  it.each(DEPENDENCIES_CASES)("$label", ({ manifest, lines, exit }) => {
    const outcome = declaredDependencyNames("echo", manifest).match(
      (names) => ({ exit: 0, lines: names }),
      (errors) => ({ exit: 1, lines: errors }),
    );
    expect(outcome).toEqual({ exit, lines });
  });
});
