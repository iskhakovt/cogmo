import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SKILLS_TEST_IMAGE,
  type SkillsImageSandbox,
  skillsImageRuntime,
  startSkillsImageSandbox,
} from "../../test/skills-image-sandbox.js";
import { hashLockfileContents } from "../deps.js";
import { makeSandboxCpythonChecks } from "./check-session.js";

/**
 * Register's CPython checks against the skills image this commit builds, in
 * Local-Docker sessions under `SANDBOX_RUNTIME` (`skillsImageRuntime`).
 *
 * Pins what replay cannot show: the tools' positions on a non-ASCII line, and
 * the import check reading a real wheel's `RECORD`. The dependency case
 * installs from PyPI, as the sysbox suite's do.
 */

const RUNTIME = skillsImageRuntime();

const IDNA_LOCKFILE = `idna==3.10 \\
    --hash=sha256:12f65c9b470abda6dc35cf8e63cc574b1c52b11df2c86030af0ac09b01b13ea9 \\
    --hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3
`;

const CLEAN = `from pydantic import BaseModel

from cogmo_ctx import Ctx


class Input(BaseModel):
    url: str


class Output(BaseModel):
    status: int


async def run(inputs: Input, ctx: Ctx) -> Output:
    response = await ctx.http.get(inputs.url)
    return Output(status=response["status"])
`;

let skillsImage: SkillsImageSandbox;

beforeAll(async () => {
  if (RUNTIME === undefined) return;
  skillsImage = await startSkillsImageSandbox(RUNTIME);
}, 120_000);

afterAll(async () => {
  await skillsImage?.stop();
});

function checks(depsCacheVolumeName: string | undefined) {
  return makeSandboxCpythonChecks({
    sandbox: skillsImage.sandbox,
    image: SKILLS_TEST_IMAGE,
    depsCacheVolumeName,
  });
}

describe.skipIf(RUNTIME === undefined)("register's CPython checks in the skills image", () => {
  it("passes a typed skill and names the image's toolchain release", async () => {
    const checked = await checks(undefined).check({
      body: CLEAN,
      dependencies: [],
      lockfile: null,
      signal: undefined,
    });

    expect(checked._unsafeUnwrap()).toEqual({
      findings: [],
      suppressions: [],
      toolchainVersion: "test",
    });
  }, 120_000);

  it("reports every check, positioned in UTF-16 units on a non-ASCII line", async () => {
    const body = [
      "import requests",
      "",
      "",
      "async def run(inputs, ctx):",
      '    s = "é😀"; x = undefined_name',
      "    return s, x, requests",
      "",
    ].join("\n");

    const checked = await checks(undefined).check({
      body,
      dependencies: [],
      lockfile: null,
      signal: undefined,
    });

    expect(checked._unsafeUnwrap().findings).toEqual([
      {
        id: "ruff",
        line: 5,
        column: 14,
        message: "E702 Multiple statements on one line (semicolon)",
      },
      { id: "ruff", line: 5, column: 20, message: "F821 Undefined name `undefined_name`" },
      {
        id: "format",
        line: 5,
        column: 14,
        message: "unformatted File would be reformatted: run `uv run ruff format` on it",
      },
      {
        id: "pyrefly",
        line: 1,
        column: 8,
        message: "missing-import Cannot find module `requests`",
      },
      {
        id: "pyrefly",
        line: 5,
        column: 20,
        message: "unknown-name Could not find name `undefined_name`",
      },
      {
        id: "imports",
        line: 1,
        column: 1,
        message:
          "'requests' is not the standard library, pydantic, pydantic_core, cogmo_ctx or a module a declared dependency installs",
      },
    ]);
  }, 120_000);

  it("reports a body CPython refuses with its syntax finding alone", async () => {
    const checked = await checks(undefined).check({
      body: 'import requests\ns = "é😀"; y = (1 2)\n',
      dependencies: [],
      lockfile: null,
      signal: undefined,
    });

    expect(checked._unsafeUnwrap().findings).toEqual([
      { id: "syntax", line: 2, column: 17, message: "invalid syntax. Perhaps you forgot a comma?" },
    ]);
  }, 120_000);

  it("installs a declared dependency on the shared volume, and allows the modules its RECORD lists", async () => {
    const depsCacheVolumeName = `cogmo-skills-test-deps-${randomUUID()}`;
    try {
      const checked = await checks(depsCacheVolumeName).check({
        body: 'import idna\n\n\nasync def run(inputs, ctx) -> str:\n    return idna.encode("b").decode()\n',
        dependencies: ["idna==3.10"],
        lockfile: { hash: hashLockfileContents(IDNA_LOCKFILE), contents: IDNA_LOCKFILE },
        signal: undefined,
      });

      // pyrefly resolved `idna` from the venv the install session populated.
      expect(checked._unsafeUnwrap().findings).toEqual([]);
    } finally {
      await skillsImage.docker
        .getVolume(depsCacheVolumeName)
        .remove()
        .catch(() => {});
    }
  }, 300_000);
});
