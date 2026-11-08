import { PassThrough } from "node:stream";
import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ExecFailure, ExecStreamingHandle } from "../../sandbox/exec.js";
import type { SandboxClient, SandboxSession, SessionSpec } from "../../sandbox/index.js";
import { expectDefined } from "../../test/assertions.js";
import { makeSandboxSchemaImporter } from "./schema-import.js";

/** What one exec does: write `stdout` and `stderr`, then exit or fail; or run until its signal aborts. */
type ExecScript =
  | { stdout?: string; stderr?: string; exitCode: number }
  | { stdout?: string; stderr?: string; failure: ExecFailure }
  | { hang: true };

interface Harness {
  sandbox: SandboxClient;
  specs: SessionSpec[];
  /** Each exec's command and the stdin it was sent, in order. */
  execs: { cmd: readonly string[]; stdin: string }[];
  deleted: number;
}

/** A sandbox whose sessions answer each exec with the next script. */
function harness(...scripts: ExecScript[]): Harness {
  const state: Harness = {
    sandbox: mock<SandboxClient>(),
    specs: [],
    execs: [],
    deleted: 0,
  };
  const sandbox = mock<SandboxClient>();
  sandbox.ensureImagePresent.mockResolvedValue();
  sandbox.create.mockImplementation(async (spec) => {
    state.specs.push(spec);
    const session = mock<SandboxSession>();
    session.execStreaming.mockImplementation(async (cmd, opts) => {
      const script = expectDefined(scripts.shift(), `a script for ${cmd.join(" ")}`);
      const entry = { cmd, stdin: "" };
      state.execs.push(entry);
      return fakeExec(script, opts?.signal, (input) => {
        entry.stdin = input;
      });
    });
    return session;
  });
  sandbox.delete.mockImplementation(async () => {
    state.deleted += 1;
  });
  state.sandbox = sandbox;
  return state;
}

/** An exec that plays `script` once its stdin ends; a hanging one settles `disposed` on `signal`. */
function fakeExec(
  script: ExecScript,
  signal: AbortSignal | undefined,
  onStdin: (input: string) => void,
): ExecStreamingHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stdin.on("data", (c: Buffer) => chunks.push(c));
  const exited = new Promise<Awaited<ExecStreamingHandle["exited"]>>((resolve) => {
    stdin.on("end", () => {
      onStdin(Buffer.concat(chunks).toString("utf-8"));
      if ("hang" in script) {
        signal?.addEventListener("abort", () => {
          stdout.end();
          stderr.end();
          resolve(err({ kind: "disposed" }));
        });
        return;
      }
      if (script.stdout) stdout.write(script.stdout);
      if (script.stderr) stderr.write(script.stderr);
      stdout.end();
      stderr.end();
      setImmediate(() =>
        resolve("failure" in script ? err(script.failure) : ok({ exitCode: script.exitCode })),
      );
    });
  });
  return {
    stdin,
    stdout,
    stderr,
    exited,
    wait: async () => {
      const exit = await exited;
      if (exit.isErr()) throw new Error(exit.error.kind);
      return exit.value;
    },
    dispose: async () => {},
  };
}

const LOCKFILE = { hash: "c".repeat(64), contents: "idna==3.10 --hash=sha256:00\n" };
const BODY = "from pydantic import BaseModel\n\nclass Input(BaseModel):\n    city: str\n";
const SCHEMAS_REPLY = `${JSON.stringify({
  type: "schemas",
  inputs: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  outputs: null,
})}\n`;

function importer(h: Harness, depsCacheVolumeName: string | undefined = "cogmo-skills-venvs") {
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

  it("installs the dependencies in a session with network, then imports with their venv and none", async () => {
    const h = harness({ exitCode: 0 }, { stdout: SCHEMAS_REPLY, exitCode: 0 });

    const imported = await importer(h).importSchemas({
      body: BODY,
      lockfile: LOCKFILE,
      resourceLimits: {},
      timeoutMs: 60_000,
    });

    expect(imported.isOk()).toBe(true);
    const volume = { volumeName: "cogmo-skills-venvs" };
    expect(h.specs.map((s) => [s.network, s.depsCacheVolume])).toEqual([
      ["bridge", volume],
      ["none", volume],
    ]);
    // The populate script, fed the lockfile, then the import naming its venv.
    expect(h.execs[0]?.cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(h.execs[0]?.stdin).toBe(LOCKFILE.contents);
    expect(h.execs[1]).toEqual({
      cmd: ["python3", "-I", "-m", "cogmo_skills_runtime.schema", LOCKFILE.hash],
      stdin: BODY,
    });
    expect(h.deleted).toBe(2);
  });

  it("stops an install the register's signal aborts, and imports nothing", async () => {
    const h = harness({ hang: true });
    const controller = new AbortController();

    const pending = importer(h).importSchemas({
      body: BODY,
      lockfile: LOCKFILE,
      resourceLimits: {},
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(h.execs).toHaveLength(1));
    controller.abort(new Error("register deadline"));
    const imported = await pending;

    expect(imported._unsafeUnwrapErr()).toMatchObject({ kind: "unavailable" });
    expect(h.specs).toHaveLength(1);
    expect(h.deleted).toBe(1);
  });

  it("refuses dependencies that do not install, and imports nothing", async () => {
    const h = harness({ stderr: "error: no wheel for idna==3.10", exitCode: 1 });

    const imported = await importer(h).importSchemas({
      body: BODY,
      lockfile: LOCKFILE,
      resourceLimits: {},
      timeoutMs: 60_000,
    });

    expect(imported._unsafeUnwrapErr()).toEqual({
      kind: "refused",
      message: "the skill's dependencies did not install: error: no wheel for idna==3.10",
    });
    expect(h.specs).toHaveLength(1);
    expect(h.deleted).toBe(1);
  });

  it("reads the last line of stdout as the reply", async () => {
    const h = harness({ stdout: `noise\n${SCHEMAS_REPLY}`, exitCode: 0 });

    const imported = await importer(h, undefined).importSchemas({
      body: BODY,
      lockfile: null,
      resourceLimits: {},
      timeoutMs: 60_000,
    });

    expect(imported.isOk()).toBe(true);
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
    {
      name: "a timeout is unavailable",
      script: {
        failure: { kind: "timed_out", deadline: "total", timeoutMs: 60_000 },
      },
      error: { kind: "unavailable", message: "the import timed out after 60000ms" },
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
