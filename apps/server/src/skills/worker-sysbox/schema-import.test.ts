import { describe, expect, it, vi } from "vitest";
import { expectDefined } from "../../test/assertions.js";
import {
  type ExecScript,
  type SessionHarness,
  sessionHarness,
} from "../../test/session-harness.js";
import { isUuid } from "../../util/uuid.js";
import { makeSandboxSchemaImporter } from "./schema-import.js";

/** A Local-Docker sandbox whose sessions answer each exec with the next script. */
function harness(...scripts: ExecScript[]): SessionHarness {
  return sessionHarness({}, ...scripts);
}

const VOLUME = "cogmo-skills-venvs";
const LOCKFILE = { hash: "c".repeat(64), contents: "idna==3.10 --hash=sha256:00\n" };
const BODY = "from pydantic import BaseModel\n\nclass Input(BaseModel):\n    city: str\n";
const SCHEMAS_REPLY = `${JSON.stringify({
  type: "schemas",
  inputs: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  outputs: null,
})}\n`;

function importer(h: SessionHarness, depsCacheVolumeName: string | undefined) {
  return makeSandboxSchemaImporter({
    sandbox: h.sandbox,
    image: "cogmo-skills:test",
    depsCacheVolumeName,
  });
}

describe("makeSandboxSchemaImporter", () => {
  it("imports a skill with no dependencies in one session created with no network", async () => {
    const h = harness({ stdout: SCHEMAS_REPLY, exitCode: 0 });

    const imported = await importer(h, undefined).importSchemas({
      body: BODY,
      lockfile: null,
      resourceLimits: { memory_bytes: 1024 },
      timeoutMs: 60_000,
    });

    expect(imported._unsafeUnwrap()).toEqual({
      inputs: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      outputs: null,
    });
    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]).toMatchObject({
      network: "none",
      image: "cogmo-skills:test",
      resourceLimits: { memory_bytes: 1024, cpus: 1 },
    });
    expect(h.specs[0]).not.toHaveProperty("depsCacheVolume");
    expect(h.execs).toEqual([
      { cmd: ["python3", "-I", "-m", "cogmo_skills_runtime.schema"], stdin: BODY },
    ]);
    expect(h.deleted).toBe(1);
  });

  it("imports a skill with dependencies in one session with no network, activating the venv on the shared volume", async () => {
    const h = harness({ stdout: SCHEMAS_REPLY, exitCode: 0 });

    const imported = await importer(h, VOLUME).importSchemas({
      body: BODY,
      lockfile: LOCKFILE,
      resourceLimits: {},
      timeoutMs: 60_000,
    });

    expect(imported.isOk()).toBe(true);
    // Register's install session populated the venv; the import installs nothing.
    expect(h.specs.map((s) => [s.network, s.depsCacheVolume])).toEqual([
      ["none", { volumeName: "cogmo-skills-venvs" }],
    ]);
    expect(h.execs).toEqual([
      { cmd: ["python3", "-I", "-m", "cogmo_skills_runtime.schema", LOCKFILE.hash], stdin: BODY },
    ]);
    expect(h.deleted).toBe(1);
    // Local-Docker names each session's cgroup slice after its task id, which must be a UUID.
    expect(isUuid(expectDefined(h.specs[0], "spec").taskId)).toBe(true);
  });

  it("stops an import the register's signal aborts", async () => {
    const h = harness({ hang: true });
    const controller = new AbortController();

    const pending = importer(h, VOLUME).importSchemas({
      body: BODY,
      lockfile: LOCKFILE,
      resourceLimits: {},
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(h.execs).toHaveLength(1));
    controller.abort(new Error("register deadline"));
    const imported = await pending;

    expect(imported._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      message: "the import was stopped",
    });
    expect(h.specs).toHaveLength(1);
    expect(h.deleted).toBe(1);
  });

  it("refuses a lockfile with no shared venv volume to carry its venv, as a caller bug", async () => {
    const h = harness();

    await expect(
      importer(h, undefined).importSchemas({
        body: BODY,
        lockfile: LOCKFILE,
        resourceLimits: {},
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("a lockfile needs the shared venv volume");
    expect(h.specs).toEqual([]);
  });

  it.each([
    {
      name: "a skill that does not load is refused",
      script: {
        stdout: `${JSON.stringify({ type: "schema_failed", error: "skill.py did not load: X" })}\n`,
        exitCode: 0,
      },
      error: { kind: "refused", message: "skill.py did not load: X" },
    },
    {
      name: "a venv that does not activate is unavailable",
      script: {
        stdout: `${JSON.stringify({ type: "fatal", error: "skill_venv: missing" })}\n`,
        exitCode: 0,
      },
      error: { kind: "unavailable", message: "the import did not start: skill_venv: missing" },
    },
    {
      name: "an exit with no reply is unavailable, quoting stderr",
      script: { stderr: "Killed\n", exitCode: 137 },
      error: { kind: "unavailable", message: "the import exited 137 with no reply: Killed" },
    },
  ] satisfies { name: string; script: ExecScript; error: unknown }[])(
    "$name",
    async ({ script, error }) => {
      const h = harness(script);

      const imported = await importer(h, undefined).importSchemas({
        body: BODY,
        lockfile: null,
        resourceLimits: {},
        timeoutMs: 60_000,
      });

      expect(imported._unsafeUnwrapErr()).toEqual(error);
      expect(h.deleted).toBe(1);
    },
  );

  it("refuses a reply past its cap", async () => {
    const h = harness({ stdout: "x".repeat(1024 * 1024 + 1), exitCode: 0 });

    const imported = await importer(h, undefined).importSchemas({
      body: BODY,
      lockfile: null,
      resourceLimits: {},
      timeoutMs: 60_000,
    });

    expect(imported._unsafeUnwrapErr()).toEqual({
      kind: "refused",
      message: "the import wrote more than 1048576 bytes to stdout",
    });
  });

  it("reports a session that does not start as unavailable", async () => {
    const h = harness();
    vi.mocked(h.sandbox.create).mockRejectedValueOnce(new Error("daemon unreachable"));

    const imported = await importer(h, undefined).importSchemas({
      body: BODY,
      lockfile: null,
      resourceLimits: {},
      timeoutMs: 60_000,
    });

    expect(imported._unsafeUnwrapErr()).toEqual({
      kind: "unavailable",
      message: "schema-import session did not start: daemon unreachable",
    });
    expect(h.deleted).toBe(0);
  });
});
