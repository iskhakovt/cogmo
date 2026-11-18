import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { SandboxSession } from "../../sandbox/index.js";
import { expectDefined } from "../../test/assertions.js";
import { type ExecScript, fakeExec, sessionHarness } from "../../test/session-harness.js";
import { isUuid } from "../../util/uuid.js";
import { execForReply, type OneShotSessionSpec, withOneShotSession } from "./one-shot-session.js";

const SPEC: OneShotSessionSpec = {
  name: "check",
  network: "none",
  depsCacheVolume: { volumeName: "cogmo-skills-venvs" },
  resourceLimits: { cpus: 1, memory_bytes: 512 * 1024 * 1024, pids: 256 },
  budgetMs: 120_000,
};

/** What `withOneShotSession` errs with when the session does not start. */
const unavailable = (message: string) => ({ kind: "unavailable" as const, message });

const ReplySchema = z.object({ type: z.literal("done"), n: z.number() });
const REPLY = `${JSON.stringify({ type: "done", n: 1 })}\n`;

/** A session whose one exec plays `script`, recording what it was sent. */
function sessionPlaying(script: ExecScript) {
  const sent: { cmd: readonly string[]; stdin: string; opts: unknown }[] = [];
  const session = mock<SandboxSession>();
  session.execStreaming.mockImplementation(async (cmd, opts) => {
    const entry = { cmd, stdin: "", opts };
    sent.push(entry);
    return fakeExec(script, opts?.signal, (input) => {
      entry.stdin = input;
    });
  });
  return { session, sent };
}

function reply(session: SandboxSession, signal?: AbortSignal) {
  return execForReply(session, {
    argv: ["python3", "-I", "-m", "cogmo_skills_runtime.check"],
    stdin: "the request",
    schema: ReplySchema,
    timeoutMs: 120_000,
    signal,
    label: "the check runner",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withOneShotSession", () => {
  it("creates the session it names, expiring 60 s past its budget, and deletes it after use", async () => {
    const h = sessionHarness({});
    const before = Date.now();

    const result = await withOneShotSession(
      { sandbox: h.sandbox, image: "cogmo-skills:test" },
      SPEC,
      undefined,
      unavailable,
      async (_session, taskId) => ok(taskId),
    );

    const [spec] = h.specs;
    expect(spec).toMatchObject({
      image: "cogmo-skills:test",
      network: "none",
      depsCacheVolume: { volumeName: "cogmo-skills-venvs" },
      resourceLimits: SPEC.resourceLimits,
    });
    // Local-Docker names the session's cgroup slice after its task id.
    expect(result._unsafeUnwrap()).toBe(expectDefined(spec, "spec").taskId);
    expect(isUuid(result._unsafeUnwrap())).toBe(true);
    const expiry = expectDefined(spec, "spec").expiresAt.getTime() - before;
    expect(expiry).toBeGreaterThanOrEqual(180_000);
    expect(expiry).toBeLessThan(181_000);
    expect(h.sandbox.ensureImagePresent).toHaveBeenCalledWith(
      "cogmo-skills:test",
      SPEC.resourceLimits,
    );
    expect(h.deleted).toBe(1);
  });

  it("mounts no volume where the spec names none", async () => {
    const h = sessionHarness({});

    await withOneShotSession(
      { sandbox: h.sandbox, image: "cogmo-skills:test" },
      { ...SPEC, depsCacheVolume: undefined },
      undefined,
      unavailable,
      async () => ok(undefined),
    );

    expect(h.specs[0]).not.toHaveProperty("depsCacheVolume");
  });

  it("deletes the session when use errs", async () => {
    const h = sessionHarness({});

    const result = await withOneShotSession(
      { sandbox: h.sandbox, image: "cogmo-skills:test" },
      SPEC,
      undefined,
      unavailable,
      async () => err(unavailable("the check runner timed out")),
    );

    expect(result._unsafeUnwrapErr()).toEqual(unavailable("the check runner timed out"));
    expect(h.deleted).toBe(1);
  });

  it("deletes the session when use throws, and rethrows", async () => {
    const h = sessionHarness({});

    await expect(
      withOneShotSession(
        { sandbox: h.sandbox, image: "cogmo-skills:test" },
        SPEC,
        undefined,
        unavailable,
        async () => {
          throw new Error("a bug");
        },
      ),
    ).rejects.toThrow("a bug");
    expect(h.deleted).toBe(1);
  });

  it("returns use's result when deleting the session fails, logging the failure", async () => {
    const warn = vi.spyOn(logger, "warn");
    const h = sessionHarness({});
    vi.mocked(h.sandbox.delete).mockRejectedValueOnce(new Error("already gone"));

    const result = await withOneShotSession(
      { sandbox: h.sandbox, image: "cogmo-skills:test" },
      SPEC,
      undefined,
      unavailable,
      async () => ok("checked"),
    );

    expect(result._unsafeUnwrap()).toBe("checked");
    expect(h.sandbox.delete).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ session: "check", err: "already gone" }),
      "sandbox.delete failed",
    );
  });

  it("errs with unavailable when the session does not start, running and deleting nothing", async () => {
    const h = sessionHarness({});
    vi.mocked(h.sandbox.create).mockRejectedValueOnce(new Error("daemon unreachable"));
    const use = vi.fn(async () => ok(undefined));

    const result = await withOneShotSession(
      { sandbox: h.sandbox, image: "cogmo-skills:test" },
      SPEC,
      undefined,
      unavailable,
      use,
    );

    expect(result._unsafeUnwrapErr()).toEqual(
      unavailable("check session did not start: daemon unreachable"),
    );
    expect(use).not.toHaveBeenCalled();
    expect(h.deleted).toBe(0);
  });

  it("starts no session once its signal has aborted, nor past an image wait the signal ends", async () => {
    const aborted = sessionHarness({});

    const refused = await withOneShotSession(
      { sandbox: aborted.sandbox, image: "cogmo-skills:test" },
      SPEC,
      AbortSignal.abort(new Error("register deadline")),
      unavailable,
      async () => ok(undefined),
    );

    expect(refused._unsafeUnwrapErr()).toEqual(
      unavailable("check session did not start: register deadline"),
    );
    expect(aborted.sandbox.ensureImagePresent).not.toHaveBeenCalled();

    const waiting = sessionHarness({});
    vi.mocked(waiting.sandbox.ensureImagePresent).mockReturnValueOnce(new Promise(() => {}));
    const controller = new AbortController();
    const pending = withOneShotSession(
      { sandbox: waiting.sandbox, image: "cogmo-skills:test" },
      SPEC,
      controller.signal,
      unavailable,
      async () => ok(undefined),
    );
    controller.abort(new Error("register deadline"));

    expect((await pending)._unsafeUnwrapErr()).toEqual(
      unavailable("check session did not start: register deadline"),
    );
    expect(waiting.sandbox.create).not.toHaveBeenCalled();
  });
});

describe("execForReply", () => {
  it("sends stdin from / and reads the last line of stdout as the reply", async () => {
    const { session, sent } = sessionPlaying({ stdout: `noise\n${REPLY}`, exitCode: 0 });
    const signal = new AbortController().signal;

    const result = await reply(session, signal);

    expect(result._unsafeUnwrap()).toEqual({ type: "done", n: 1 });
    expect(sent).toEqual([
      {
        cmd: ["python3", "-I", "-m", "cogmo_skills_runtime.check"],
        stdin: "the request",
        opts: { workingDir: "/", attachStdin: true, timeoutMs: 120_000, signal },
      },
    ]);
  });

  it("reads the reply past a terminal's control bytes and carriage returns on its line", async () => {
    // A PTY-backed exec (Daytona's, for stdin) echoes the typed command, and
    // the shell turns bracketed paste off on the reply's own line.
    const stdout = `$ exec bash -c '…'\r\n\u001b[?2004l\r${REPLY.replace("\n", "\r\n")}`;
    const { session } = sessionPlaying({ stdout, exitCode: 0 });

    expect((await reply(session))._unsafeUnwrap()).toEqual({ type: "done", n: 1 });
  });

  it("tells a reply past its cap, which the code the exec ran wrote, from a failure", async () => {
    const { session } = sessionPlaying({ stdout: "x".repeat(1024 * 1024 + 1), exitCode: 0 });

    const result = await reply(session);

    expect(result._unsafeUnwrapErr()).toEqual({
      kind: "overflow",
      message: "the check runner wrote more than 1048576 bytes to stdout",
    });
  });

  it("still reads a reply past its cap as overflow when disposing the exec fails", async () => {
    const session = mock<SandboxSession>();
    session.execStreaming.mockImplementationOnce(async () => ({
      ...fakeExec({ stdout: "x".repeat(1024 * 1024 + 1), exitCode: 0 }, undefined, () => {}),
      dispose: async () => {
        throw new Error("exec already gone");
      },
    }));

    expect((await reply(session))._unsafeUnwrapErr()).toMatchObject({ kind: "overflow" });
  });

  it.each([
    {
      name: "an exit with no reply, quoting stderr's tail",
      script: { stderr: "Killed\n", exitCode: 137 },
      message: "the check runner exited 137 with no reply: Killed",
    },
    {
      name: "a last line the schema refuses",
      script: { stdout: '{"type":"done"}\n', exitCode: 0 },
      message: "the check runner exited 0 with no reply",
    },
    {
      name: "a timeout",
      script: { failure: { kind: "timed_out", deadline: "total", timeoutMs: 120_000 } },
      message: "the check runner timed out after 120000ms",
    },
    {
      name: "a disposed exec",
      script: { stderr: "partial\n", failure: { kind: "disposed" } },
      message: "the check runner was stopped: partial",
    },
    {
      name: "a transport failure",
      script: { failure: { kind: "transport_failed", error: new Error("socket closed") } },
      message: "the check runner's exec failed: socket closed",
    },
    {
      name: "an exit with no code",
      script: { failure: { kind: "no_exit_code", reason: "inspect returned null" } },
      message: "the check runner ended with no exit code: inspect returned null",
    },
    {
      name: "a stream that fails",
      script: { streamError: "pipe broke", exitCode: 0 },
      message: "the check runner's streams failed: pipe broke",
    },
  ] satisfies { name: string; script: ExecScript; message: string }[])(
    "fails on $name",
    async ({ script, message }) => {
      const { session } = sessionPlaying(script);

      expect((await reply(session))._unsafeUnwrapErr()).toEqual({ kind: "failed", message });
    },
  );

  it("fails on an exec that does not start, and one with no stdin", async () => {
    const notStarted = mock<SandboxSession>();
    notStarted.execStreaming.mockRejectedValueOnce(new Error("exec create failed"));
    const noStdin = mock<SandboxSession>();
    noStdin.execStreaming.mockImplementationOnce(async () => {
      const { stdin: _stdin, ...rest } = fakeExec({ exitCode: 0 }, undefined, () => {});
      return rest;
    });

    expect((await reply(notStarted))._unsafeUnwrapErr()).toEqual({
      kind: "failed",
      message: "the check runner did not start: exec create failed",
    });
    expect((await reply(noStdin))._unsafeUnwrapErr()).toEqual({
      kind: "failed",
      message: "the check runner's exec has no stdin",
    });
  });

  it("returns the reply when disposing the exec fails", async () => {
    const session = mock<SandboxSession>();
    session.execStreaming.mockImplementationOnce(async () => ({
      ...fakeExec({ stdout: REPLY, exitCode: 0 }, undefined, () => {}),
      dispose: async () => {
        throw new Error("exec already gone");
      },
    }));

    expect((await reply(session))._unsafeUnwrap()).toEqual({ type: "done", n: 1 });
  });
});
