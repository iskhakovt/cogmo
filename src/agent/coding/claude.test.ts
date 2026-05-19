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

// Frame shapes the runner writes to stdin. Schemas live in the test file
// because they only describe the observable wire format we assert on, not
// the runner's internal types.
const StdinFrameSchema = z.object({
  type: z.literal("user"),
  message: z.object({ role: z.literal("user"), content: z.string() }),
});

const ControlResponseFrameSchema = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.string(),
    subtype: z.string(),
    response: z.object({
      behavior: z.enum(["allow", "deny"]),
      message: z.string().optional(),
    }),
  }),
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

  it("invokes claude with the slice-1 plan flag set", async () => {
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
    // Per-callsite timeout pair pins the wedge-resilience contract —
    // see design/coding-delegation.md → Per-callsite exec timeouts.
    // 30-minute total cap + 5-minute idle cap on claude streams.
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

  describe("ExitPlanMode permission round-trip", () => {
    // Mirrors what Claude Code emits when plan mode completes:
    // text_delta → tool_use(ExitPlanMode) → control_request → result.
    // The runner must reply `behavior: "allow"` on stdin or the CLI
    // blocks until its 5-min idle timeout.
    const EXIT_PLAN_MODE_FIXTURE = [
      '{"type":"system","subtype":"init","session_id":"sess-epm","model":"claude-sonnet-4"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"## Plan\\n"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"1. add foo\\n"}}}',
      '{"type":"assistant","message":{"role":"assistant","content":[' +
        '{"type":"tool_use","id":"toolu_epm","name":"ExitPlanMode","input":{"plan":"## Plan\\n1. add foo\\n"}}' +
        "]}}",
      '{"type":"control_request","request_id":"req_epm","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"## Plan\\n1. add foo\\n"}}}',
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.012,"usage":{"input_tokens":420,"output_tokens":86}}',
      "",
    ].join("\n");

    it("auto-allows ExitPlanMode and writes the control_response to stdin", async () => {
      const { container, stdinChunks } = fakeContainer(EXIT_PLAN_MODE_FIXTURE);
      const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));

      // permission_request must not escape the runner.
      expect(events.find((e) => e.kind === "permission_request")).toBeUndefined();

      const planReady = events.find((e) => e.kind === "plan_ready");
      assertKind(planReady, "plan_ready");
      expect(planReady.plan).toBe("## Plan\n1. add foo\n");

      const lines = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const responseFrame = ControlResponseFrameSchema.parse(JSON.parse(lines[1] ?? "{}"));
      expect(responseFrame.type).toBe("control_response");
      expect(responseFrame.response.request_id).toBe("req_epm");
      expect(responseFrame.response.subtype).toBe("success");
      expect(responseFrame.response.response).toEqual({ behavior: "allow" });
    });

    // A `control_response` must land on stdin AFTER the user prompt —
    // proves stdin stayed writable through the permission round-trip.
    it("keeps stdin open until the control_response is written", async () => {
      const { container, stdinChunks } = fakeContainer(EXIT_PLAN_MODE_FIXTURE);
      await collect(new ClaudeCodeBackend().plan({ task, repo, container }));

      const frames = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => TaggedFrameSchema.parse(JSON.parse(l)));
      const types = frames.map((f) => f.type);
      expect(types[0]).toBe("user");
      expect(types).toContain("control_response");
    });

    it("auto-allows non-ExitPlanMode plan-mode tools (e.g. Write to the CLI's plan file)", async () => {
      // CLI 2.1.x routes intermediate Read/Write/Bash through the same
      // control channel — denying breaks the CLI's own plan-completion
      // protocol (Write to ~/.claude/plans/<task>.md before ExitPlanMode).
      const fixture = [
        '{"type":"system","subtype":"init","session_id":"sess-write","model":"m"}',
        '{"type":"control_request","request_id":"req_write","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/home/vscode/.claude/plans/task.md","content":"## Plan"}}}',
        '{"type":"result","subtype":"success","is_error":false}',
        "",
      ].join("\n");
      const { container, stdinChunks } = fakeContainer(fixture);
      const events = await collect(new ClaudeCodeBackend().plan({ task, repo, container }));

      expect(events.find((e) => e.kind === "permission_request")).toBeUndefined();

      const lines = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const responseFrame = ControlResponseFrameSchema.parse(JSON.parse(lines[1] ?? "{}"));
      expect(responseFrame.response.response).toEqual({ behavior: "allow" });
    });

    // Parser-level dedupe (`parseClaudeStream`'s `seenPermissionRequestIds`)
    // collapses repeated control_request frames at the source — the runner
    // sees only one permission_request, and writes one control_response.
    it("collapses duplicate control_request frames at the parser layer", async () => {
      const fixture = [
        '{"type":"system","subtype":"init","session_id":"sess-dup","model":"m"}',
        '{"type":"control_request","request_id":"req_dup","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{}}}',
        '{"type":"control_request","request_id":"req_dup","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{}}}',
        '{"type":"result","subtype":"success","is_error":false}',
        "",
      ].join("\n");
      const { container, stdinChunks } = fakeContainer(fixture);
      await collect(new ClaudeCodeBackend().plan({ task, repo, container }));

      const controlResponses = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => TaggedFrameSchema.parse(JSON.parse(l)))
        .filter((f) => f.type === "control_response");
      expect(controlResponses.length).toBe(1);
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
    const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);
    const events = await collect(handle.events);

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

  it("invokes claude with --resume <sid> and NO --permission-mode flag (default mode gates every tool call)", async () => {
    const { container, execStreaming } = fakeContainer(EXECUTE_FIXTURE);
    const backend = new ClaudeCodeBackend();
    const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);
    await collect(handle.events);

    expect(execStreaming).toHaveBeenCalledTimes(1);
    const [cmd] = expectDefined(execStreaming.mock.calls[0], "execStreaming call");
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("--resume");
    expect(cmd[cmd.indexOf("--resume") + 1]).toBe(sessionId);
    // No --permission-mode in execute flags — stream-json control protocol
    // surfaces every tool call as a permission_request the orchestrator
    // resolves via handle.respondPermission.
    expect(cmd).not.toContain("--permission-mode");
    expect(cmd).not.toContain("acceptEdits");
    expect(cmd).not.toContain("plan");
  });

  it("sends the execute prompt (not the plan prompt) on stdin", async () => {
    const { container, stdinChunks } = fakeContainer(EXECUTE_FIXTURE);
    const backend = new ClaudeCodeBackend();
    const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);
    await collect(handle.events);

    const written = stdinChunks.join("");
    // First frame is the user prompt — find it among any subsequent
    // control_response frames the orchestrator may have written.
    const firstFrame = written.split("\n").find((line) => line.trim().length > 0) ?? "";
    const parsed = StdinFrameSchema.parse(JSON.parse(firstFrame));
    expect(parsed.type).toBe("user");
    expect(parsed.message.content).toContain("# Approved");
    expect(parsed.message.content).toContain("Proceed with the implementation");
    expect(parsed.message.content).toContain(repo.verifyCommand);
    expect(parsed.message.content).not.toContain("# Task");
  });

  it("does NOT close stdin after the prompt (must stay open for control_response)", async () => {
    const { container, stdinChunks: _ } = fakeContainer(EXECUTE_FIXTURE);
    void _;
    const backend = new ClaudeCodeBackend();
    const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);
    // Reach into the exec mock to inspect stdin.writableEnded after the
    // prompt is written but before result. Iterate to drain.
    await collect(handle.events);
    // After completion the runner closes stdin itself; assertions on the
    // open-stdin invariant happen mid-stream in the permission test below.
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
    const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);
    const events = await collect(handle.events);
    const result = events.find((e) => e.kind === "tool_result");
    assertKind(result, "tool_result");
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("exit 1");
  });

  it("rejects empty sessionId", async () => {
    const { container } = fakeContainer(EXECUTE_FIXTURE);
    const backend = new ClaudeCodeBackend();
    await expect(backend.execute({ task: taskWithSession, repo, container }, "")).rejects.toThrow(
      /without a session id/,
    );
  });

  describe("permission protocol", () => {
    it("yields permission_request on control_request and serializes the response onto stdin", async () => {
      // Fixture: one control_request mid-stream, then result. The test
      // drives respondPermission and asserts the stdin frame format.
      const fixture = [
        '{"type":"system","subtype":"init","session_id":"sess-p","model":"m"}',
        '{"type":"control_request","request_id":"req_42","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git push"}}}',
        '{"type":"result","subtype":"success","is_error":false}',
        "",
      ].join("\n");
      const { container, stdinChunks } = fakeContainer(fixture);
      const backend = new ClaudeCodeBackend();
      const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);

      const events: CodingEvent[] = [];
      for await (const ev of handle.events) {
        events.push(ev);
        if (ev.kind === "permission_request") {
          await handle.respondPermission(ev.requestId, { behavior: "allow" });
        }
      }

      const req = events.find((e) => e.kind === "permission_request");
      assertKind(req, "permission_request");
      expect(req.requestId).toBe("req_42");
      expect(req.tool).toBe("Bash");
      expect(req.input).toEqual({ command: "git push" });

      // Stdin should now contain prompt + control_response frames.
      const lines = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      // First line: user prompt; second: control_response.
      const responseFrame = ControlResponseFrameSchema.parse(JSON.parse(lines[1] ?? "{}"));
      expect(responseFrame.type).toBe("control_response");
      expect(responseFrame.response.request_id).toBe("req_42");
      expect(responseFrame.response.subtype).toBe("success");
      expect(responseFrame.response.response).toEqual({ behavior: "allow" });
    });

    it("supports deny responses with a message", async () => {
      const fixture = [
        '{"type":"system","subtype":"init","session_id":"sess-p2","model":"m"}',
        '{"type":"control_request","request_id":"req_99","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /"}}}',
        '{"type":"result","subtype":"success","is_error":false}',
        "",
      ].join("\n");
      const { container, stdinChunks } = fakeContainer(fixture);
      const backend = new ClaudeCodeBackend();
      const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);

      for await (const ev of handle.events) {
        if (ev.kind === "permission_request") {
          await handle.respondPermission(ev.requestId, {
            behavior: "deny",
            message: "user-rejected",
          });
        }
      }

      const lines = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const responseFrame = ControlResponseFrameSchema.parse(JSON.parse(lines[1] ?? "{}"));
      expect(responseFrame.response.response.behavior).toBe("deny");
      expect(responseFrame.response.response.message).toBe("user-rejected");
    });

    it("dedupes a duplicate respondPermission call for the same request id", async () => {
      const fixture = [
        '{"type":"system","subtype":"init","session_id":"sess-p3","model":"m"}',
        '{"type":"control_request","request_id":"req_dup","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}',
        '{"type":"result","subtype":"success","is_error":false}',
        "",
      ].join("\n");
      const { container, stdinChunks } = fakeContainer(fixture);
      const backend = new ClaudeCodeBackend();
      const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);

      for await (const ev of handle.events) {
        if (ev.kind === "permission_request") {
          await handle.respondPermission(ev.requestId, { behavior: "allow" });
          // Second call for the same id is a no-op.
          await handle.respondPermission(ev.requestId, { behavior: "deny" });
        }
      }

      const responseFrames = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => TaggedFrameSchema.parse(JSON.parse(l)))
        .filter((f) => f.type === "control_response")
        .map((f) => ControlResponseFrameSchema.parse(f));
      expect(responseFrames).toHaveLength(1);
      expect(expectDefined(responseFrames[0]).response.response.behavior).toBe("allow");
    });

    it("ignores control_request with unknown subtype", async () => {
      const fixture = [
        '{"type":"system","subtype":"init","session_id":"sess-p4","model":"m"}',
        '{"type":"control_request","request_id":"req_x","request":{"subtype":"interrupt"}}',
        '{"type":"result","subtype":"success","is_error":false}',
        "",
      ].join("\n");
      const { container } = fakeContainer(fixture);
      const backend = new ClaudeCodeBackend();
      const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);
      const events = await collect(handle.events);
      expect(events.find((e) => e.kind === "permission_request")).toBeUndefined();
    });

    it("emits two interleaved permission_request events in stdin arrival order (FIFO)", async () => {
      const fixture = [
        '{"type":"system","subtype":"init","session_id":"sess-fifo","model":"m"}',
        '{"type":"control_request","request_id":"req_first","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git push"}}}',
        '{"type":"control_request","request_id":"req_second","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm publish"}}}',
        '{"type":"result","subtype":"success","is_error":false}',
        "",
      ].join("\n");
      const { container, stdinChunks } = fakeContainer(fixture);
      const backend = new ClaudeCodeBackend();
      const handle = await backend.execute({ task: taskWithSession, repo, container }, sessionId);

      const requestIds: string[] = [];
      for await (const ev of handle.events) {
        if (ev.kind === "permission_request") {
          requestIds.push(ev.requestId);
          await handle.respondPermission(ev.requestId, { behavior: "allow" });
        }
      }
      // Events surface in stdout arrival order — the async generator
      // doesn't reorder. Same order is preserved on the response stream.
      expect(requestIds).toEqual(["req_first", "req_second"]);

      const responseFrames = stdinChunks
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => TaggedFrameSchema.parse(JSON.parse(l)))
        .filter((f) => f.type === "control_response")
        .map((f) => ControlResponseFrameSchema.parse(f).response.request_id);
      expect(responseFrames).toEqual(["req_first", "req_second"]);
    });
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
    const handle = await new ClaudeCodeBackend().execute(
      { task: { ...task, sessionId: "sess-tu" }, repo, container },
      "sess-tu",
    );
    const events = await collect(handle.events);
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
    const handle = await new ClaudeCodeBackend().execute(
      { task: { ...task, sessionId: "sess-tr" }, repo, container },
      "sess-tr",
    );
    const events = await collect(handle.events);
    const result = events.find((e) => e.kind === "tool_result");
    assertKind(result, "tool_result");
    expect(result.tool).toBe("Read");
    expect(result.ok).toBe(true);
    expect(result.summary).toBeUndefined();
  });

  it("ignores can_use_tool control_request missing tool_name", async () => {
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"sess-cr","model":"m"}',
      '{"type":"control_request","request_id":"req_no_name","request":{"subtype":"can_use_tool","input":{}}}',
      '{"type":"result","subtype":"success","is_error":false}',
      "",
    ].join("\n");
    const { container } = fakeContainer(fixture);
    const handle = await new ClaudeCodeBackend().execute(
      { task: { ...task, sessionId: "sess-cr" }, repo, container },
      "sess-cr",
    );
    const events = await collect(handle.events);
    expect(events.find((e) => e.kind === "permission_request")).toBeUndefined();
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
    const handle = await new ClaudeCodeBackend().execute(
      { task: { ...task, sessionId: "sess-oo" }, repo, container },
      "sess-oo",
    );
    const events = await collect(handle.events);
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
