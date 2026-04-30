import { describe, expect, it } from "vitest";
import { taskSliceName } from "./cgroup-parent.js";

describe("taskSliceName", () => {
  it("produces a stable systemd slice unit name from a task id", () => {
    const taskId = "019d0000-0000-7000-8000-00000000aaaa";
    expect(taskSliceName(taskId)).toBe("cogmo-task-019d000000007000800000000000aaaa.slice");
  });

  it("strips UUID dashes so the id portion is a single token", () => {
    const slice = taskSliceName("019d1234-5678-7abc-89de-f01234567890");
    // The `cogmo-task-` prefix has its own dash; strip the prefix before
    // checking the id portion is dashless.
    expect(slice.replace(/^cogmo-task-/, "")).not.toContain("-");
    expect(slice.endsWith(".slice")).toBe(true);
  });

  it("two different task ids produce different slice names", () => {
    const a = taskSliceName("019d0000-0000-7000-8000-000000000001");
    const b = taskSliceName("019d0000-0000-7000-8000-000000000002");
    expect(a).not.toBe(b);
  });

  it("emits exactly the documented `cogmo-task-<dashless-uuid>.slice` shape", () => {
    // Regression canary: the slice name is an exact contract — `HostConfig.
    // CgroupParent` is forwarded into Docker which exec's it as a systemd
    // unit name. The 32-hex id portion plus the literal prefix/suffix is
    // pinned end-to-end (see design/sandbox.md). If this test breaks,
    // confirm the change is intentional and update the regex below in
    // lockstep with the format string.
    const slice = taskSliceName("019d1234-5678-7abc-89de-f01234567890");
    expect(slice).toMatch(/^cogmo-task-[0-9a-f]{32}\.slice$/);
  });

  it("uses only systemd-safe slice unit characters", () => {
    // Systemd unit names accept a restricted set; alphanumeric + `-` + `.`
    // is the conservative subset we emit. Pinning the character class
    // guards against future refactors that might smuggle in `_`, `:`, or
    // upper-case hex.
    const slice = taskSliceName("019d1234-5678-7abc-89de-f01234567890");
    expect(slice).toMatch(/^[a-z0-9.-]+$/);
  });

  it("stays well under systemd's 255-char unit-name limit", () => {
    // `cogmo-task-` (11) + 32 hex + `.slice` (6) = 49. Pinned so a future
    // schema change (longer prefix, multi-part id) can't accidentally
    // cross the systemd limit.
    const slice = taskSliceName("019d1234-5678-7abc-89de-f01234567890");
    expect(slice.length).toBe(49);
    expect(slice.length).toBeLessThan(255);
  });

  it("rejects a non-UUID input with a descriptive error", () => {
    // The impl validates via `isUuid` — defence in depth so a malformed
    // id can't synthesise an arbitrary unit name reaching Docker /
    // systemd. Pin the throw + the message shape.
    expect(() => taskSliceName("not-a-uuid")).toThrow(/expected a UUID/);
  });

  it("rejects upper-case UUIDs (lowercase-only contract)", () => {
    // `isUuid` is case-sensitive — Cogmo emits lowercase UUIDv7s
    // throughout. An upper-case id reaching this function is a bug
    // upstream; fail loudly rather than silently lower-casing.
    expect(() => taskSliceName("019D0000-0000-7000-8000-00000000AAAA")).toThrow(/expected a UUID/);
  });

  it("rejects an empty string", () => {
    expect(() => taskSliceName("")).toThrow(/expected a UUID/);
  });

  it("rejects a UUID with surrounding whitespace", () => {
    // No trimming — the caller is responsible for handing us a clean id.
    expect(() => taskSliceName(" 019d0000-0000-7000-8000-00000000aaaa ")).toThrow(
      /expected a UUID/,
    );
  });
});
