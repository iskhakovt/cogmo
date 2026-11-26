import { describe, expect, it } from "vitest";
import { ExecIds } from "./exec-ids.js";

describe("ExecIds", () => {
  it("knows an id it recorded and no other", () => {
    const ids = new ExecIds();
    ids.add("a");

    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(false);
  });

  it("forgets the oldest id past 4096, and keeps the rest", () => {
    const ids = new ExecIds();
    const recorded = Array.from({ length: 4097 }, (_, i) => `exec-${i}`);
    for (const id of recorded) ids.add(id);

    expect(ids.has("exec-0")).toBe(false);
    expect(ids.has("exec-1")).toBe(true);
    expect(ids.has("exec-4096")).toBe(true);
  });
});
