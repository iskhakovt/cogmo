import { PassThrough } from "node:stream";
import { err, ok } from "neverthrow";
import { mock } from "vitest-mock-extended";
import type { ExecFailure, ExecStreamingHandle } from "../sandbox/exec.js";
import type {
  SandboxCapabilities,
  SandboxClient,
  SandboxSession,
  SessionSpec,
} from "../sandbox/index.js";
import { expectDefined } from "./assertions.js";

/** What one exec does: write `stdout` and `stderr`, then exit or fail; or run until its signal aborts. */
export type ExecScript =
  | { stdout?: string; stderr?: string; exitCode: number }
  | { stdout?: string; stderr?: string; failure: ExecFailure }
  | { hang: true }
  | { streamError: string; exitCode: number };

export interface SessionHarness {
  sandbox: SandboxClient;
  specs: SessionSpec[];
  /** Each exec's command and the stdin it was sent, in order. */
  execs: { cmd: readonly string[]; stdin: string }[];
  deleted: number;
}

/**
 * A sandbox whose sessions answer each exec with the next script, recording
 * every session it creates, every exec and every delete.
 */
export function sessionHarness(
  capabilities: Partial<SandboxCapabilities>,
  ...scripts: ExecScript[]
): SessionHarness {
  const sandbox = mock<SandboxClient>({
    capabilities: {
      siblingContainers: "host-proxy",
      hostBindMount: true,
      customImage: true,
      volumes: "docker",
      workingTreeTransport: "bind-mount",
      depsCacheSharing: "shared-volume",
      noNetworkSessions: true,
      ...capabilities,
    },
  });
  const state: SessionHarness = { sandbox, specs: [], execs: [], deleted: 0 };
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
  return state;
}

/** An exec that plays `script` once its stdin ends; a hanging one settles `disposed` on `signal`. */
export function fakeExec(
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
      if ("streamError" in script) {
        stdout.emit("error", new Error(script.streamError));
        stdout.end();
        stderr.end();
        setImmediate(() => resolve(ok({ exitCode: script.exitCode })));
        return;
      }
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
