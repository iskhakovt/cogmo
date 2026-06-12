import { PassThrough, type Readable, type Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ExecStreamingHandle,
  LocalDockerSessionState,
  SandboxSession,
} from "../../sandbox/index.js";
import { assertKind, expectDefined } from "../../test/assertions.js";
import type { CodingEvent } from "./backend.js";
import { ClaudeCodeBackend } from "./claude.js";
import type { CodingRepoRow, CodingTaskRow } from "./store/index.js";

const StdinFrameSchema = z.object({
  type: z.literal("user"),
  message: z.object({ role: z.literal("user"), content: z.string() }),
});

const TaggedFrameSchema = z.object({ type: z.string() }).passthrough();

/**
 * Build a fake `TaskContainerHandle` whose `exec()` returns an `ExecHandle`
 * backed by the given fixture stdout. stderr is empty; wait() resolves with
 * the configured exit code once the script `end()`s the stdout.
 */
type ExecStreamingMock = ReturnType<
  typeof vi.fn<
    (cmd: ReadonlyArray<string>, opts?: { attachStdin?: boolean }) => Promise<ExecStreamingHandle>
  >
>;

function fakeContainer(
  fixture: string,
  exitCode = 0,
): {
  container: SandboxSession<LocalDockerSessionState>;
  execStreaming: ExecStreamingMock;
  stdinChunks: string[];
} {
  const stdinChunks: string[] = [];
  const execStreaming: ExecStreamingMock = vi.fn(async () => {
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
      dispose: async () => {},
    };
  });
  return {
    container: {
      state: {
        type: "local-docker",
        taskId: "t",
        containerRowId: "c",
        dockerId: "d",
      },
      exec: vi.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        wallTimeSeconds: 0,
        truncated: false,
      })),
      execStreaming,
    },
    execStreaming,
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
  identityName: "default",
  verifyTimeoutSeconds: 600,
  createdAt: new Date(),
};

const task: CodingTaskRow = {
  id: "t",
  repoId: "r",
  conversationId: null,
  goal: "add a foo function",
  triggerSource: "user",
  triggerRef: null,
  backend: "claude",
  worktreeAssignment: { type: "host-path", branch: "cogmo/abc", worktreePath: "/worktrees/abc" },
  sessionId: null,
  containerId: null,
  allowPrivilegedRunc: false,
  plan: null,
  planApprovedAt: null,
  prMetadata: null,
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

    const session = events[0];
    assertKind(session, "session_started");
    expect(session.sessionId).toBe("sess-abc-123");

    const planReady = events[4];
    assertKind(planReady, "plan_ready");
    expect(planReady.plan).toBe("## Plan\n1. Add foo()\n2. Add a test\n");

    const complete = events[5];
    assertKind(complete, "complete");
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
    const parsed = StdinFrameSchema.parse(JSON.parse(written.trim()));
    expect(parsed.type).toBe("user");
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toContain("add a foo function");
    expect(parsed.message.content).toContain("Current branch: cogmo/abc");
  });

  it("invokes claude with the plan flag set", async () => {
    const { container, execStreaming } = fakeContainer(FIXTURE);
    const backend = new ClaudeCodeBackend();
    await collect(backend.plan({ task, repo, container }));

    expect(execStreaming).toHaveBeenCalledTimes(1);
    const [cmd, opts] = expectDefined(execStreaming.mock.calls[0], "execStreaming call");
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("-p");
    expect(cmd).toContain("--output-format");
    expect(cmd).toContain("stream-json");
    expect(cmd).toContain("--include-partial-messages");
    expect(cmd).toContain("--input-format");
    expect(cmd).toContain("--permission-mode");
    expect(cmd).toContain("plan");
    // Sandbox isolation is the security boundary — neither runner passes
    // `--permission-prompt-tool stdio`, so the CLI never opens a
    // bidirectional control channel.
    expect(cmd).not.toContain("--permission-prompt-tool");
    // Per-callsite timeout pair pins the wedge-resilience contract —
    // see design/coding-delegation.md → Per-callsite exec timeouts.
    expect(opts).toEqual({
      attachStdin: true,
      timeoutMs: 30 * 60 * 1000,
      idleTimeoutMs: 5 * 60 * 1000,
    });
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
    const complete = events.at(-1);
    assertKind(complete, "complete");
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
    const text = events.find((e) => e.kind === "text_delta");
    assertKind(text, "text_delta");
    expect(text.text).toBe("hello");
  });

  describe("stdin lifecycle", () => {
    // `--input-format stream-json` uses stdin EOF as the documented
    // graceful-shutdown signal. The runner must close stdin immediately
    // after the prompt frame so the CLI exits cleanly once it finishes
    // streaming; holding stdin open wedges the subprocess after `result`
    // because the remote-exec stdin proxy fails to deliver a post-`result`
    // EOF in time.
    it("closes stdin immediately after writing the prompt", async () => {
      const { container, execStreaming } = fakeContainer(FIXTURE);
      await collect(new ClaudeCodeBackend().plan({ task, repo, container }));

      const handlePromise = execStreaming.mock.results[0];
      if (handlePromise?.type !== "return") {
        throw new Error("execStreaming did not return a handle");
      }
      const handle = await handlePromise.value;
      expect(handle.stdin?.writableEnded).toBe(true);
    });

    it("writes exactly one stdin frame — the user prompt", async () => {
      const { container, stdinChunks } = fakeContainer(FIXTURE);
      await collect(new ClaudeCodeBackend().plan({ task, repo, container }));

      const frames = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => TaggedFrameSchema.parse(JSON.parse(l)));
      expect(frames.map((f) => f.type)).toEqual(["user"]);
    });
  });
});

// Execute mode fixture: Claude resumes a session, narrates ("Adding foo()..."),
// reads a file, edits it, runs the verify command, and reports success. Tool
// blocks come from consolidated assistant/user messages; text comes from
// partial-message deltas. Includes one repeated tool_use block in the result
// payload to exercise dedup.
const EXECUTE_FIXTURE = [
  '{"type":"system","subtype":"init","session_id":"sess-exec-1","model":"claude-sonnet-4"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Adding foo()...\\n"}}}',
  '{"type":"assistant","message":{"role":"assistant","content":[' +
    '{"type":"text","text":"Adding foo()..."},' +
    '{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"/workspace/src/foo.ts"}}' +
    "]}}",
  '{"type":"user","message":{"role":"user","content":[' +
    '{"type":"tool_result","tool_use_id":"toolu_01","content":"export function foo() {}","is_error":false}' +
    "]}}",
  '{"type":"assistant","message":{"role":"assistant","content":[' +
    '{"type":"tool_use","id":"toolu_02","name":"Edit","input":{"file_path":"/workspace/src/foo.ts","new":"return 42"}}' +
    "]}}",
  '{"type":"user","message":{"role":"user","content":[' +
    '{"type":"tool_result","tool_use_id":"toolu_02","content":"edited","is_error":false}' +
    "]}}",
  '{"type":"assistant","message":{"role":"assistant","content":[' +
    '{"type":"tool_use","id":"toolu_03","name":"Bash","input":{"command":"pnpm test"}}' +
    "]}}",
  '{"type":"user","message":{"role":"user","content":[' +
    '{"type":"tool_result","tool_use_id":"toolu_03","content":"all tests passing","is_error":false}' +
    "]}}",
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done.\\n"}}}',
  // Repeat tool_use block in result payload — must be deduped, not re-emitted.
  '{"type":"assistant","message":{"role":"assistant","content":[' +
    '{"type":"tool_use","id":"toolu_03","name":"Bash","input":{"command":"pnpm test"}}' +
    "]}}",
  '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.084,"usage":{"input_tokens":3120,"output_tokens":640}}',
  "",
].join("\n");

describe("ClaudeCodeBackend.execute", () => {
  const sessionId = "sess-plan-prior";
  const taskWithSession = { ...task, sessionId };

  it("emits session, text, tool_call, tool_result, complete — no plan_ready", async () => {
    const { container } = fakeContainer(EXECUTE_FIXTURE);
    const backend = new ClaudeCodeBackend();
    const events = await collect(
      backend.execute({ task: taskWithSession, repo, container }, sessionId),
    );

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "session_started",
      "text_delta",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "text_delta",
      "complete",
    ]);
    expect(kinds).not.toContain("plan_ready");

    const calls = events.filter(
      (e): e is Extract<CodingEvent, { kind: "tool_call" }> => e.kind === "tool_call",
    );
    expect(calls.map((c) => c.tool)).toEqual(["Read", "Edit", "Bash"]);

    const results = events.filter(
      (e): e is Extract<CodingEvent, { kind: "tool_result" }> => e.kind === "tool_result",
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(expectDefined(results[0]).summary).toBe("export function foo() {}");
    // tool_result.tool must be the human-readable name (resolved from the
    // tool_use block), NOT the opaque tool_use_id.
    expect(results.map((r) => r.tool)).toEqual(["Read", "Edit", "Bash"]);

    const complete = events.at(-1);
    assertKind(complete, "complete");
    expect(complete.exitCode).toBe(0);
    expect(complete.isError).toBe(false);
    expect(complete.usage).toEqual({ inputTokens: 3120, outputTokens: 640, costUsd: 0.084 });
  });

  it("invokes claude with --resume <sid> and bypassPermissions", async () => {
    const { container, execStreaming } = fakeContainer(EXECUTE_FIXTURE);
    const backend = new ClaudeCodeBackend();
    await collect(backend.execute({ task: taskWithSession, repo, container }, sessionId));

    expect(execStreaming).toHaveBeenCalledTimes(1);
    const [cmd] = expectDefined(execStreaming.mock.calls[0], "execStreaming call");
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("--resume");
    expect(cmd[cmd.indexOf("--resume") + 1]).toBe(sessionId);
    // Sandbox is the security boundary; CLI resolves tool calls
    // locally with no stdio control channel.
    expect(cmd).toContain("--permission-mode");
    expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(cmd).not.toContain("--permission-prompt-tool");
    expect(cmd).not.toContain("acceptEdits");
    expect(cmd).not.toContain("plan");
  });

  it("sends the execute prompt (not the plan prompt) on stdin", async () => {
    const { container, stdinChunks } = fakeContainer(EXECUTE_FIXTURE);
    const backend = new ClaudeCodeBackend();
    await collect(backend.execute({ task: taskWithSession, repo, container }, sessionId));

    const written = stdinChunks.join("");
    const firstFrame = written.split("\n").find((line) => line.trim().length > 0) ?? "";
    const parsed = StdinFrameSchema.parse(JSON.parse(firstFrame));
    expect(parsed.type).toBe("user");
    expect(parsed.message.content).toContain("# Approved");
    expect(parsed.message.content).toContain("Proceed with the implementation");
    expect(parsed.message.content).toContain(repo.verifyCommand);
    expect(parsed.message.content).not.toContain("# Task");
  });

  it("closes stdin immediately after writing the prompt", async () => {
    const { container, execStreaming } = fakeContainer(EXECUTE_FIXTURE);
    await collect(
      new ClaudeCodeBackend().execute({ task: taskWithSession, repo, container }, sessionId),
    );

    const handlePromise = execStreaming.mock.results[0];
    if (handlePromise?.type !== "return") {
      throw new Error("execStreaming did not return a handle");
    }
    const handle = await handlePromise.value;
    expect(handle.stdin?.writableEnded).toBe(true);
  });

  it("surfaces tool_result with ok=false when is_error is true", async () => {
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-err","model":"m"}',
      '{"type":"assistant","message":{"role":"assistant","content":[' +
        '{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"false"}}' +
        "]}}",
      '{"type":"user","message":{"role":"user","content":[' +
        '{"type":"tool_result","tool_use_id":"t1","content":"exit 1","is_error":true}' +
        "]}}",
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const backend = new ClaudeCodeBackend();
    const events = await collect(
      backend.execute({ task: taskWithSession, repo, container }, sessionId),
    );
    const result = events.find((e) => e.kind === "tool_result");
    assertKind(result, "tool_result");
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("exit 1");
  });

  it("rejects empty sessionId", async () => {
    const { container } = fakeContainer(EXECUTE_FIXTURE);
    const backend = new ClaudeCodeBackend();
    expect(() => backend.execute({ task: taskWithSession, repo, container }, "")).toThrow(
      /without a session id/,
    );
  });
});

// Schema robustness: parser is intentionally permissive — every event is
// `safeParse`d via the discriminated union, blocks via per-block schemas,
// and unknown / malformed shapes silently fall through. These tests pin
// that contract so a future refactor doesn't accidentally start throwing
// (the CLI emits forward-compatible additions all the time, and one bad
// event must not abort the whole run).
describe("ClaudeCodeBackend stream-json schema robustness", () => {
  it("silently drops events with unknown top-level type", async () => {
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-u","model":"m"}',
      '{"type":"future_event_kind","data":{"foo":"bar"}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));
    expect(events.map((e) => e.kind)).toEqual([
      "session_started",
      "text_delta",
      "plan_ready",
      "complete",
    ]);
  });

  it("silently drops events with missing 'type' field", async () => {
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-nt","model":"m"}',
      '{"subtype":"init","session_id":"orphan"}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));
    // Only the well-formed system event surfaces session_started.
    const sessions = events.filter((e) => e.kind === "session_started");
    expect(sessions).toHaveLength(1);
    const firstNt = sessions[0];
    assertKind(firstNt, "session_started");
    expect(firstNt.sessionId).toBe("sess-nt");
  });

  it("does not emit session_started when system event has no session_id", async () => {
    const fixture = [
      '{"type":"system","subtype":"init"}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));
    expect(events.find((e) => e.kind === "session_started")).toBeUndefined();
  });

  it("does not emit session_started for non-init system subtypes", async () => {
    const fixture = [
      '{"type":"system","subtype":"compact","session_id":"ignored"}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));
    expect(events.find((e) => e.kind === "session_started")).toBeUndefined();
  });

  it("emits session_started only once even if multiple init events arrive", async () => {
    // Anthropic occasionally re-emits init when a sub-agent boots; we must
    // surface the first session id and ignore the rest (the orchestrator
    // persists session_id on first arrival via setTaskSessionId, which is
    // not a no-op on the second write).
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-1","model":"m"}',
      '{"type":"system","subtype":"init","session_id":"sess-2","model":"m"}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));
    const sessions = events.filter((e) => e.kind === "session_started");
    expect(sessions).toHaveLength(1);
    const first1 = sessions[0];
    assertKind(first1, "session_started");
    expect(first1.sessionId).toBe("sess-1");
  });

  it("skips assistant tool_use blocks missing required fields", async () => {
    // Missing `id` and missing `name` each fail ToolUseBlockSchema.safeParse
    // and get skipped without aborting the surrounding message.
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-tu","model":"m"}',
      '{"type":"assistant","message":{"role":"assistant","content":[' +
        '{"type":"tool_use","name":"Read","input":{}},' +
        '{"type":"tool_use","id":"toolu_ok","name":"Edit","input":{"x":1}},' +
        '{"type":"tool_use","id":"toolu_no_name","input":{}}' +
        "]}}",
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(
      new ClaudeCodeBackend().execute(
        { task: { ...task, sessionId: "sess-tu" }, repo, container },
        "sess-tu",
      ),
    );
    const calls = events.filter(
      (e): e is Extract<CodingEvent, { kind: "tool_call" }> => e.kind === "tool_call",
    );
    expect(calls).toHaveLength(1);
    expect(expectDefined(calls[0]).tool).toBe("Edit");
  });

  it("emits tool_result without summary when content is not a string", async () => {
    // Anthropic sometimes returns structured content (array of blocks for
    // multimodal results). The parser only surfaces a `summary` field when
    // content is a plain string; structured shapes flow through as `ok`/`tool`
    // only, no summary.
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-tr","model":"m"}',
      '{"type":"assistant","message":{"role":"assistant","content":[' +
        '{"type":"tool_use","id":"t1","name":"Read","input":{}}' +
        "]}}",
      '{"type":"user","message":{"role":"user","content":[' +
        '{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"x"}]}' +
        "]}}",
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(
      new ClaudeCodeBackend().execute(
        { task: { ...task, sessionId: "sess-tr" }, repo, container },
        "sess-tr",
      ),
    );
    const result = events.find((e) => e.kind === "tool_result");
    assertKind(result, "tool_result");
    expect(result.tool).toBe("Read");
    expect(result.ok).toBe(true);
    expect(result.summary).toBeUndefined();
  });

  it("emits complete with no token counts when result has no usage block", async () => {
    // Pins observable behavior: when the CLI's `result` event omits both
    // `usage` and `total_cost_usd`, the resulting `complete` event MUST NOT
    // expose token counts or cost (downstream surfaces this as "no usage
    // data"). Implementation detail: an empty object may still be present
    // — the contract is "no fields", not "no key".
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-nu","model":"m"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));
    const complete = events.at(-1);
    assertKind(complete, "complete");
    expect(complete.usage?.inputTokens).toBeUndefined();
    expect(complete.usage?.outputTokens).toBeUndefined();
    expect(complete.usage?.costUsd).toBeUndefined();
    expect(complete.exitCode).toBe(0);
    expect(complete.isError).toBe(false);
  });

  it("falls back to tool_use_id as tool name when tool_result arrives before tool_use", async () => {
    // Anthropic emits assistant.tool_use BEFORE user.tool_result in normal
    // order. The fallback path exists for defensive parsing — assert it
    // produces a usable tool_result event with id-as-name rather than
    // dropping the result entirely.
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-oo","model":"m"}',
      '{"type":"user","message":{"role":"user","content":[' +
        '{"type":"tool_result","tool_use_id":"toolu_orphan","content":"ok"}' +
        "]}}",
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(
      new ClaudeCodeBackend().execute(
        { task: { ...task, sessionId: "sess-oo" }, repo, container },
        "sess-oo",
      ),
    );
    const result = events.find((e) => e.kind === "tool_result");
    assertKind(result, "tool_result");
    expect(result.tool).toBe("toolu_orphan");
    expect(result.ok).toBe(true);
  });

  it("text_delta arriving before session_started still streams (parser does not reorder)", async () => {
    // The contract is "events surface in stdout arrival order". Out-of-order
    // arrival isn't expected from the CLI, but the parser must not gate
    // text_delta on session_started having fired — pinning that contract so
    // a future refactor doesn't introduce a stall.
    const fixture = [
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"early"}}}',
      '{"type":"system","subtype":"init","session_id":"sess-ord","model":"m"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"late"}}}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "text_delta",
      "session_started",
      "text_delta",
      "plan_ready",
      "complete",
    ]);
    const planReady = events.find((e) => e.kind === "plan_ready");
    assertKind(planReady, "plan_ready");
    expect(planReady.plan).toBe("earlylate");
  });
});
