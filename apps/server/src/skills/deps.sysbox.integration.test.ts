import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxSession } from "../sandbox/index.js";
import { expectDefined } from "../test/assertions.js";
import {
  SKILLS_TEST_IMAGE,
  type SkillsImageSandbox,
  skillsImageRuntime,
  startSkillsImageSandbox,
} from "../test/skills-image-sandbox.js";
import {
  DEFAULT_DEPENDENCY_SESSION_LIMITS,
  ensureVenvPopulated,
  hashLockfileContents,
  isLockfileContentRefusal,
} from "./deps.js";

/**
 * The populate script in sessions of the skills image this commit builds,
 * under `SANDBOX_RUNTIME` (`skillsImageRuntime`): the messages the image's uv
 * writes, which `isLockfileContentRefusal` reads. Its packages come from a
 * `file://` index the test writes in the session, so no case reaches PyPI.
 */

const RUNTIME = skillsImageRuntime();

const IDNA_LOCKFILE = `idna==3.10 \\
    --hash=sha256:12f65c9b470abda6dc35cf8e63cc574b1c52b11df2c86030af0ac09b01b13ea9 \\
    --hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3
`;

/**
 * Writes a wheel and an sdist per case to the directory it is given, with a
 * PEP 503 simple index over them, and prints each artefact's sha256.
 */
const MAKE_PACKAGES = String.raw`
import base64, hashlib, io, os, sys, tarfile, zipfile
out = sys.argv[1]
os.makedirs(out)
def digest(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()
def wheel(name, tag):
    dist = f"{name}-1.0.dist-info"
    files = {f"{name}/__init__.py": b"", f"{dist}/METADATA": f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n".encode(),
             f"{dist}/WHEEL": f"Wheel-Version: 1.0\nGenerator: t\nRoot-Is-Purelib: true\nTag: {tag}\n".encode()}
    record = "".join(f"{p},sha256={base64.urlsafe_b64encode(hashlib.sha256(c).digest()).rstrip(b'=').decode()},{len(c)}\n" for p, c in files.items())
    files[f"{dist}/RECORD"] = (record + f"{dist}/RECORD,,\n").encode()
    path = os.path.join(out, f"{name}-1.0-{tag}.whl")
    with zipfile.ZipFile(path, "w") as z:
        for p, c in files.items():
            z.writestr(p, c)
    return path
def sdist(name):
    path = os.path.join(out, f"{name}-1.0.tar.gz")
    data = f"Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n".encode()
    with tarfile.open(path, "w:gz") as t:
        info = tarfile.TarInfo(f"{name}-1.0/PKG-INFO"); info.size = len(data); t.addfile(info, io.BytesIO(data))
    return path
artefacts = {"okpkg": wheel("okpkg", "py3-none-any"), "cponly": wheel("cponly", "cp312-cp312-manylinux_2_17_x86_64"), "sdistonly": sdist("sdistonly")}
for name, path in artefacts.items():
    os.makedirs(os.path.join(out, "simple", name))
    with open(os.path.join(out, "simple", name, "index.html"), "w") as f:
        f.write(f'<a href="../../{os.path.basename(path)}#sha256={digest(path)}">{os.path.basename(path)}</a>\n')
    print(name, digest(path))
`;

let skillsImage: SkillsImageSandbox;

beforeAll(async () => {
  if (RUNTIME === undefined) return;
  skillsImage = await startSkillsImageSandbox(RUNTIME);
}, 120_000);

afterAll(async () => {
  await skillsImage?.stop();
});

describe.skipIf(RUNTIME === undefined)("the skills image's uv", () => {
  /** A session whose uv resolves from `index`, which the test writes packages to. */
  async function withIndexSession<T>(
    index: string,
    use: (session: SandboxSession) => Promise<T>,
  ): Promise<T> {
    const session = await skillsImage.sandbox.create({
      taskId: randomUUID(),
      image: SKILLS_TEST_IMAGE,
      resourceLimits: DEFAULT_DEPENDENCY_SESSION_LIMITS,
      expiresAt: new Date(Date.now() + 300_000),
      network: "none",
      env: { UV_DEFAULT_INDEX: index, UV_HTTP_RETRIES: "0" },
    });
    try {
      return await use(session);
    } finally {
      await skillsImage.sandbox.delete(session);
    }
  }

  async function populateFailure(session: SandboxSession, lockfile: string): Promise<string> {
    const populated = await ensureVenvPopulated({
      session,
      lockfileHash: hashLockfileContents(lockfile),
      lockfileContents: lockfile,
      workerId: "pin",
    });
    const failure = populated._unsafeUnwrapErr();
    expect(failure.kind).toBe("populate_failed");
    return failure.message;
  }

  it("refuses a lockfile's content in the words register reads as a verdict on it", async () => {
    await withIndexSession("file:///tmp/packages/simple", async (session) => {
      const made = await session.exec(["python3", "-I", "-c", MAKE_PACKAGES, "/tmp/packages"]);
      expect(made.exitCode, made.stderr).toBe(0);
      const digests = new Map(
        made.stdout
          .trim()
          .split("\n")
          .flatMap((line) => {
            const [name, digest] = line.split(" ");
            return name && digest ? [[name, digest] as const] : [];
          }),
      );
      const digestOf = (name: string): string => expectDefined(digests.get(name), name);
      const pin = (name: string, digest: string): string =>
        `${name}==1.0 --hash=sha256:${digest}\n`;

      const refusals = [
        await populateFailure(session, pin("sdistonly", digestOf("sdistonly"))),
        await populateFailure(session, pin("cponly", digestOf("cponly"))),
        await populateFailure(session, pin("okpkg", "0".repeat(64))),
      ];

      expect(refusals.map(isLockfileContentRefusal), refusals.join("\n---\n")).toEqual([
        true,
        true,
        true,
      ]);
    });
  }, 300_000);

  it("fails to reach an index in words register leaves to a retry", async () => {
    await withIndexSession("http://127.0.0.1:9/simple", async (session) => {
      const message = await populateFailure(session, IDNA_LOCKFILE);

      expect(isLockfileContentRefusal(message), message).toBe(false);
    });
  }, 300_000);
});
