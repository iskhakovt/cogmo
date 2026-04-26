import { PassThrough, type Readable, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExecHandle, TaskContainerHandle } from "../../sandbox/index.js";
import type { CodingEvent } from "./backend.js";
import { ClaudeCodeBackend } from "./claude.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

/**
 * Build a fake `TaskContainerHandle` whose `exec()` returns an `ExecHandle`
 * backed by the given fixture stdout. stderr is empty; wait() resolves with
 * the configured exit code once the script `end()`s the stdout.
 */
function fakeContainer(
  fixture: string,
  exitCode = 0,
): {
  container: TaskContainerHandle;
  stdinChunks: string[];
} {
  const stdinChunks: string[] = [];
  const exec = vi.fn(async (): Promise<ExecHandle> => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin: Writable = new PassThrough();
    stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk.toString("utf8")));

    // Push the fixture asynchronously so the consumer is iterating before we
    // close the stream.
    queueMicrotask(() => {
      stdout.write(fixture);
      stdout.end();
      stderr.end();
    });

    return {
      stdin,
      stdout: stdout as Readable,
      stderr: stderr as Readable,
      wait: async () => ({ exitCode }),
    };
  });
  return {
    container: {
      containerRowId: "c",
      dockerId: "d",
      exec,
    },
    stdinChunks,
  };
}

const repo: CodingRepoRow = {
  id: "r",
  name: "cogmo",
  localPath: "/repos/cogmo",
  defaultBranch: "main",
  remoteUrl: "git@github.com:user/cogmo.git",
  devcontainer: null,
  allowedBackends: ["claude"],
  verifyCommand: "pnpm test",
  taskTokenBudget: 100_000,
  taskWallTimeSeconds: 600,
  maxConcurrentTasks: 1,
  createdAt: new Date(),
};

const task: CodingTaskRow = {
  id: "t",
  repoId: "r",
  goal: "add a foo function",
  triggerSource: "user",
  triggerRef: null,
  backend: "claude",
  worktreeAssignment: { branch: "cogmo/abc", worktreePath: "/worktrees/abc" },
  sessionId: null,
  containerId: null,
  allowPrivilegedRunc: false,
  plan: null,
  planApprovedAt: null,
  prUrl: null,
  status: "queued",
  failureReason: null,
  resourceUsage: null,
  createdAt: new Date(),
};

async function collect(stream: AsyncIterable<CodingEvent>): Promise<CodingEvent[]> {
  const out: CodingEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const FIXTURE = [
  '{"type":"system","subtype":"init","session_id":"sess-abc-123","model":"claude-sonnet-4"}',
  // Partial-message deltas streaming the plan text.
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"## Plan\\n"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"1. Add foo()\\n"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"2. Add a test\\n"}}}',
  // A full assistant message arrives too — we ignore it because deltas already covered it.
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"## Plan\\n1. Add foo()\\n2. Add a test\\n"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.012,"usage":{"input_tokens":420,"output_tokens":86}}',
  "",
].join("\n");

describe("ClaudeCodeBackend.plan", () => {
  it("emits session_started, text_deltas, plan_ready, complete in order", async () => {
    const { container } = fakeContainer(FIXTURE);
    const backend = new ClaudeCodeBackend();
    const events = await collect(backend.plan({ task, repo, container }));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "session_started",
      "text_delta",
      "text_delta",
      "text_delta",
      "plan_ready",
      "complete",
    ]);

    const session = events[0] as Extract<CodingEvent, { kind: "session_started" }>;
    expect(session.sessionId).toBe("sess-abc-123");

    const planReady = events[4] as Extract<CodingEvent, { kind: "plan_ready" }>;
    expect(planReady.plan).toBe("## Plan\n1. Add foo()\n2. Add a test\n");

    const complete = events[5] as Extract<CodingEvent, { kind: "complete" }>;
    expect(complete.exitCode).toBe(0);
    expect(complete.isError).toBe(false);
    expect(complete.usage).toEqual({ inputTokens: 420, outputTokens: 86, costUsd: 0.012 });
  });

  it("writes the prompt as a stream-json user message on stdin", async () => {
    const { container, stdinChunks } = fakeContainer(FIXTURE);
    const backend = new ClaudeCodeBackend();
    await collect(backend.plan({ task, repo, container }));

    const written = stdinChunks.join("");
    expect(written).toMatch(/\n$/);
    const parsed = JSON.parse(written.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toContain("add a foo function");
    expect(parsed.message.content).toContain("Current branch: cogmo/abc");
  });

  it("invokes claude with the slice-1 plan flag set", async () => {
    const { container } = fakeContainer(FIXTURE);
    const backend = new ClaudeCodeBackend();
    await collect(backend.plan({ task, repo, container }));

    const exec = container.exec as ReturnType<typeof vi.fn>;
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, opts] = exec.mock.calls[0];
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("--output-format");
    expect(cmd).toContain("stream-json");
    expect(cmd).toContain("--include-partial-messages");
    expect(cmd).toContain("--input-format");
    expect(cmd).toContain("--permission-mode");
    expect(cmd).toContain("plan");
    expect(opts).toEqual({ attachStdin: true });
  });

  it("propagates non-zero exit code with isError=true", async () => {
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-x","model":"m"}',
      '{"type":"result","subtype":"error","is_error":true}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture, 2);
    const backend = new ClaudeCodeBackend();
    const events = await collect(backend.plan({ task, repo, container }));
    const complete = events.at(-1) as Extract<CodingEvent, { kind: "complete" }>;
    expect(complete.exitCode).toBe(2);
    expect(complete.isError).toBe(true);
    // Plan-ready not emitted on error.
    expect(events.find((e) => e.kind === "plan_ready")).toBeUndefined();
  });

  it("does not emit plan_ready when the result arrives with empty plan text", async () => {
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-y","model":"m"}',
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":10,"output_tokens":0}}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const backend = new ClaudeCodeBackend();
    const events = await collect(backend.plan({ task, repo, container }));
    expect(events.find((e) => e.kind === "plan_ready")).toBeUndefined();
    expect(events.at(-1)?.kind).toBe("complete");
  });

  it("handles malformed lines mixed into the stream", async () => {
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-z","model":"m"}',
      "not a json line at all",
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const backend = new ClaudeCodeBackend();
    const events = await collect(backend.plan({ task, repo, container }));
    const text = events.find((e) => e.kind === "text_delta") as Extract<
      CodingEvent,
      { kind: "text_delta" }
    >;
    expect(text.text).toBe("hello");
  });
});
