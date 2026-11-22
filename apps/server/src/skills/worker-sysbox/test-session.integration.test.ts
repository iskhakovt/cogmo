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
import { makeSandboxSkillTests } from "./test-session.js";

/**
 * Register's run of a skill's tests against the skills image this commit
 * builds, in Local-Docker sessions under `SANDBOX_RUNTIME`
 * (`skillsImageRuntime`).
 *
 * Pins what replay cannot show: the image's pytest under the toolchain's
 * configuration, the session's missing network interface, and a dependency
 * read from the venv register's install session populated on the shared
 * volume, which installs from PyPI as the CPython checks' suite does.
 */

const RUNTIME = skillsImageRuntime();

const IDNA_LOCKFILE = `idna==3.10 \\
    --hash=sha256:12f65c9b470abda6dc35cf8e63cc574b1c52b11df2c86030af0ac09b01b13ea9 \\
    --hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3
`;

const MANIFEST = "---\nname: echo\ntier: container\n---\n";
const BODY = 'async def run(inputs, ctx):\n    return {"x": inputs["x"] + 1}\n';

let skillsImage: SkillsImageSandbox;

beforeAll(async () => {
  if (RUNTIME === undefined) return;
  skillsImage = await startSkillsImageSandbox(RUNTIME);
}, 120_000);

afterAll(async () => {
  await skillsImage?.stop();
});

function tests(depsCacheVolumeName: string | undefined) {
  return makeSandboxSkillTests({
    sandbox: skillsImage.sandbox,
    image: SKILLS_TEST_IMAGE,
    depsCacheVolumeName,
  });
}

describe.skipIf(RUNTIME === undefined)("register's tests in the skills image", () => {
  it("passes a suite under the toolchain's configuration, counting its tests", async () => {
    const ran = await tests(undefined).run({
      files: {
        "SKILL.md": MANIFEST,
        "skill.py": BODY,
        "test_skill.py": [
          "import cogmo_ctx",
          "from skill import run",
          "",
          "",
          "async def test_adds():",
          '    assert await run({"x": 1}, None) == {"x": 2}',
          "",
          "",
          "def test_reads_the_toolchains_cogmo_ctx():",
          '    assert cogmo_ctx.__file__.startswith("/opt/cogmo-skills/toolchain/.cogmo/")',
          "",
        ].join("\n"),
      },
      lockfile: null,
      resourceLimits: {},
      signal: undefined,
    });

    expect(ran._unsafeUnwrap()).toBe(2);
  }, 120_000);

  it("refuses a failing test at its line, and a test reaching for the network finds no interface", async () => {
    const ran = await tests(undefined).run({
      files: {
        "SKILL.md": MANIFEST,
        "skill.py": BODY,
        "test_skill.py": [
          "import socket",
          "",
          "from skill import run",
          "",
          "",
          "async def test_adds():",
          '    assert await run({"x": 1}, None) == {"x": 3}',
          "",
          "",
          "def test_reaches_nothing():",
          '    socket.create_connection(("1.1.1.1", 80), timeout=5)',
          "",
        ].join("\n"),
      },
      lockfile: null,
      resourceLimits: {},
      signal: undefined,
    });

    expect(ran._unsafeUnwrapErr()).toEqual({
      kind: "failed",
      findings: [
        { line: 6, message: "test_adds: AssertionError: assert {'x': 2} == {'x': 3}" },
        { line: 10, message: "test_reaches_nothing: OSError: [Errno 101] Network is unreachable" },
      ],
    });
  }, 120_000);

  it("imports a declared dependency from the venv the install session populated on the shared volume", async () => {
    const depsCacheVolumeName = `cogmo-skills-test-deps-${randomUUID()}`;
    const lockfile = { hash: hashLockfileContents(IDNA_LOCKFILE), contents: IDNA_LOCKFILE };
    const body =
      'import idna\n\n\nasync def run(inputs, ctx) -> str:\n    return idna.encode("b").decode()\n';
    try {
      const checked = await makeSandboxCpythonChecks({
        sandbox: skillsImage.sandbox,
        image: SKILLS_TEST_IMAGE,
        depsCacheVolumeName,
      }).check({ body, testBody: null, dependencies: ["idna==3.10"], lockfile, signal: undefined });
      expect(checked._unsafeUnwrap().testRunner).toBe(true);

      const ran = await tests(depsCacheVolumeName).run({
        files: {
          "SKILL.md": MANIFEST,
          "skill.py": body,
          "test_skill.py":
            'from skill import run\n\n\nasync def test_encodes():\n    assert await run({}, None) == "b"\n',
          "requirements.lock": IDNA_LOCKFILE,
        },
        lockfile,
        resourceLimits: {},
        signal: undefined,
      });

      expect(ran._unsafeUnwrap()).toBe(1);
    } finally {
      await skillsImage.docker
        .getVolume(depsCacheVolumeName)
        .remove()
        .catch(() => {});
    }
  }, 300_000);
});
