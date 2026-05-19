import { describe, expect, it } from "vitest";
import {
  CtxCallSchema,
  CtxResultSchema,
  TaskInvokeSchema,
  TaskResultSchema,
  WorkerMessageSchema,
} from "./protocol.js";

describe("TaskInvokeSchema", () => {
  it("accepts a canonical task_invoke", () => {
    expect(
      TaskInvokeSchema.parse({
        type: "task_invoke",
        id: "task-1",
        skill: "echo",
        inputs: { x: 1 },
      }),
    ).toMatchObject({ type: "task_invoke", id: "task-1" });
  });

  it("accepts arbitrary unknown inputs", () => {
    const r = TaskInvokeSchema.parse({
      type: "task_invoke",
      id: "t",
      skill: "s",
      inputs: null,
    });
    expect(r.inputs).toBeNull();
  });

  it("rejects wrong type literal", () => {
    expect(() =>
      TaskInvokeSchema.parse({
        type: "TaskInvoke",
        id: "t",
        skill: "s",
        inputs: {},
      }),
    ).toThrow();
  });

  it("rejects missing id", () => {
    expect(() => TaskInvokeSchema.parse({ type: "task_invoke", skill: "s", inputs: {} })).toThrow();
  });

  it("rejects empty id", () => {
    expect(() =>
      TaskInvokeSchema.parse({
        type: "task_invoke",
        id: "",
        skill: "s",
        inputs: {},
      }),
    ).toThrow();
  });

  it("rejects non-string id", () => {
    expect(() =>
      TaskInvokeSchema.parse({
        type: "task_invoke",
        id: 42,
        skill: "s",
        inputs: {},
      }),
    ).toThrow();
  });

  it("rejects missing skill", () => {
    expect(() => TaskInvokeSchema.parse({ type: "task_invoke", id: "t", inputs: {} })).toThrow();
  });
});

describe("TaskResultSchema (discriminated)", () => {
  it("ok:true requires output", () => {
    expect(
      TaskResultSchema.parse({
        type: "task_result",
        id: "t",
        ok: true,
        output: { v: 1 },
      }),
    ).toMatchObject({ ok: true, output: { v: 1 } });
  });

  it("ok:true accepts null output", () => {
    expect(
      TaskResultSchema.parse({ type: "task_result", id: "t", ok: true, output: null }),
    ).toMatchObject({ ok: true, output: null });
  });

  it("ok:false requires error string", () => {
    expect(
      TaskResultSchema.parse({
        type: "task_result",
        id: "t",
        ok: false,
        error: "boom",
      }),
    ).toMatchObject({ ok: false, error: "boom" });
  });

  it("ok:false rejects non-string error", () => {
    expect(() =>
      TaskResultSchema.parse({
        type: "task_result",
        id: "t",
        ok: false,
        error: 42,
      }),
    ).toThrow();
  });

  it("ok:true with error field falls through (extra fields ignored on success branch)", () => {
    // Documented behavior — Zod doesn't strict-mode by default, extras are dropped.
    const r = TaskResultSchema.parse({
      type: "task_result",
      id: "t",
      ok: true,
      output: 1,
      error: "ignored",
    });
    expect(r).toMatchObject({ ok: true, output: 1 });
  });

  it("rejects missing ok", () => {
    expect(() => TaskResultSchema.parse({ type: "task_result", id: "t", output: 1 })).toThrow();
  });

  it("accepts task_result with rusage on the ok variant", () => {
    const r = TaskResultSchema.parse({
      type: "task_result",
      id: "t",
      ok: true,
      output: 42,
      rusage: { peakMemoryBytes: 2_097_152 },
    });
    expect(r).toMatchObject({ ok: true, rusage: { peakMemoryBytes: 2_097_152 } });
  });

  it("accepts task_result with rusage on the err variant", () => {
    const r = TaskResultSchema.parse({
      type: "task_result",
      id: "t",
      ok: false,
      error: "boom",
      rusage: { peakMemoryBytes: 1024 },
    });
    expect(r).toMatchObject({ ok: false, rusage: { peakMemoryBytes: 1024 } });
  });

  it("accepts task_result without rusage (synthesised supervisor results)", () => {
    // Supervisor timeouts / SIGKILL paths synthesise the task_result
    // without the child's rusage — the field is optional by design.
    const r = TaskResultSchema.parse({
      type: "task_result",
      id: "t",
      ok: false,
      error: "wall_clock_exceeded",
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as { rusage?: unknown }).rusage).toBeUndefined();
  });

  it("rejects negative peakMemoryBytes inside rusage", () => {
    expect(() =>
      TaskResultSchema.parse({
        type: "task_result",
        id: "t",
        ok: true,
        output: null,
        rusage: { peakMemoryBytes: -1 },
      }),
    ).toThrow();
  });
});

describe("CtxCallSchema", () => {
  it("accepts canonical ctx_call", () => {
    const r = CtxCallSchema.parse({
      type: "ctx_call",
      id: "ctx-1",
      method: "secrets.get",
      args: { name: "foo" },
    });
    expect(r.method).toBe("secrets.get");
  });

  it("rejects empty method", () => {
    expect(() =>
      CtxCallSchema.parse({ type: "ctx_call", id: "c", method: "", args: {} }),
    ).toThrow();
  });

  it("accepts unknown args (validation done by ctx-handler, not protocol)", () => {
    expect(() =>
      CtxCallSchema.parse({
        type: "ctx_call",
        id: "c",
        method: "now",
        args: undefined,
      }),
    ).not.toThrow();
  });
});

describe("CtxResultSchema (discriminated)", () => {
  it("ok:true requires value", () => {
    const r = CtxResultSchema.parse({
      type: "ctx_result",
      id: "c",
      ok: true,
      value: "secret-value",
    });
    expect(r).toMatchObject({ ok: true, value: "secret-value" });
  });

  it("ok:false requires errorKind AND message", () => {
    const r = CtxResultSchema.parse({
      type: "ctx_result",
      id: "c",
      ok: false,
      errorKind: "not_in_allowlist",
      message: "missing declaration",
    });
    expect(r).toMatchObject({ ok: false, errorKind: "not_in_allowlist" });
  });

  it("ok:false rejects missing errorKind", () => {
    expect(() =>
      CtxResultSchema.parse({
        type: "ctx_result",
        id: "c",
        ok: false,
        message: "x",
      }),
    ).toThrow();
  });

  it("ok:false rejects missing message", () => {
    expect(() =>
      CtxResultSchema.parse({
        type: "ctx_result",
        id: "c",
        ok: false,
        errorKind: "x",
      }),
    ).toThrow();
  });

  it("ok:false rejects empty errorKind", () => {
    expect(() =>
      CtxResultSchema.parse({
        type: "ctx_result",
        id: "c",
        ok: false,
        errorKind: "",
        message: "x",
      }),
    ).toThrow();
  });
});

describe("WorkerMessageSchema (discriminated union)", () => {
  it.each([
    {
      name: "task_invoke",
      msg: { type: "task_invoke", id: "t", skill: "s", inputs: {} },
    },
    {
      name: "task_result ok",
      msg: { type: "task_result", id: "t", ok: true, output: 1 },
    },
    {
      name: "task_result err",
      msg: { type: "task_result", id: "t", ok: false, error: "x" },
    },
    {
      name: "ctx_call",
      msg: { type: "ctx_call", id: "c", method: "now", args: {} },
    },
    {
      name: "ctx_result ok",
      msg: { type: "ctx_result", id: "c", ok: true, value: 1 },
    },
    {
      name: "ctx_result err",
      msg: {
        type: "ctx_result",
        id: "c",
        ok: false,
        errorKind: "internal",
        message: "x",
      },
    },
  ])("accepts $name", ({ msg }) => {
    expect(() => WorkerMessageSchema.parse(msg)).not.toThrow();
  });

  it.each([
    null,
    undefined,
    42,
    "string",
    [],
    { type: "garbage" },
    {},
    { type: "ctx_call" },
  ])("rejects garbage input %#", (input) => {
    expect(() => WorkerMessageSchema.parse(input)).toThrow();
  });

  it("rejects unknown type literal", () => {
    expect(() => WorkerMessageSchema.parse({ type: "task_started", id: "t" })).toThrow();
  });
});
