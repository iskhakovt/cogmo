import { describe, expect, it } from "vitest";
import { diffPins, hashToolSchema } from "./approval.js";
import type { McpToolDescriptor, McpToolPin } from "./config.js";

const baseSnapshot = {
  description: "Create a pull request",
  inputSchema: {
    type: "object",
    properties: { repo: { type: "string" }, title: { type: "string" } },
    required: ["repo", "title"],
  },
};

describe("hashToolSchema", () => {
  it("is stable across calls for the same input", () => {
    expect(hashToolSchema(baseSnapshot)).toBe(hashToolSchema(baseSnapshot));
  });

  it("ignores property order in objects", () => {
    const reorderedProps = {
      description: baseSnapshot.description,
      inputSchema: {
        type: "object",
        required: ["title", "repo"], // arrays preserve order — different on purpose; but properties order shouldn't matter
        properties: { title: { type: "string" }, repo: { type: "string" } },
      },
    };
    // Property reordering of `properties` should hash identically; but `required`
    // is an array and order *is* meaningful (list of required keys).
    const reorderedPropsOnly = {
      description: baseSnapshot.description,
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, repo: { type: "string" } },
        required: ["repo", "title"],
      },
    };
    expect(hashToolSchema(reorderedPropsOnly)).toBe(hashToolSchema(baseSnapshot));
    // Sanity: different `required` order does change the hash (arrays are ordered).
    expect(hashToolSchema(reorderedProps)).not.toBe(hashToolSchema(baseSnapshot));
  });

  it("changes when description changes", () => {
    const changed = { ...baseSnapshot, description: "Open a PR" };
    expect(hashToolSchema(changed)).not.toBe(hashToolSchema(baseSnapshot));
  });

  it("changes when inputSchema changes", () => {
    const changed = {
      ...baseSnapshot,
      inputSchema: {
        ...baseSnapshot.inputSchema,
        properties: {
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
      },
    };
    expect(hashToolSchema(changed)).not.toBe(hashToolSchema(baseSnapshot));
  });

  it("returns a 64-char hex sha256", () => {
    expect(hashToolSchema(baseSnapshot)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("diffPins", () => {
  function pin(
    toolName: string,
    snapshot = baseSnapshot,
    status = "approved" as const,
  ): McpToolPin {
    return {
      id: `pin-${toolName}`,
      serverId: "server-1",
      toolName,
      schemaHash: hashToolSchema(snapshot),
      schemaSnapshot: snapshot,
      approvalStatus: status,
      createdAt: new Date(),
    };
  }

  function descriptor(name: string, snapshot = baseSnapshot): McpToolDescriptor {
    return { name, description: snapshot.description, inputSchema: snapshot.inputSchema };
  }

  it("classifies an unchanged tool as unchanged", () => {
    const diff = diffPins([descriptor("create_pr")], [pin("create_pr")]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.mutated).toEqual([]);
    expect(diff.unchanged.map((p) => p.toolName)).toEqual(["create_pr"]);
  });

  it("flags a new tool as added", () => {
    const diff = diffPins([descriptor("create_pr"), descriptor("close_pr")], [pin("create_pr")]);
    expect(diff.added.map((t) => t.name)).toEqual(["close_pr"]);
    expect(diff.unchanged.map((p) => p.toolName)).toEqual(["create_pr"]);
    expect(diff.removed).toEqual([]);
  });

  it("flags a vanished tool as removed", () => {
    const diff = diffPins([descriptor("create_pr")], [pin("create_pr"), pin("close_pr")]);
    expect(diff.removed).toEqual(["close_pr"]);
    expect(diff.unchanged.map((p) => p.toolName)).toEqual(["create_pr"]);
    expect(diff.added).toEqual([]);
  });

  it("flags a description change as mutated", () => {
    const newSnap = { ...baseSnapshot, description: "Open a PR (renamed)" };
    const diff = diffPins([descriptor("create_pr", newSnap)], [pin("create_pr")]);
    expect(diff.mutated.map((m) => m.tool.name)).toEqual(["create_pr"]);
    expect(diff.unchanged).toEqual([]);
  });

  it("flags an inputSchema change as mutated", () => {
    const newSnap = {
      ...baseSnapshot,
      inputSchema: { ...baseSnapshot.inputSchema, required: ["repo"] },
    };
    const diff = diffPins([descriptor("create_pr", newSnap)], [pin("create_pr")]);
    expect(diff.mutated.map((m) => m.tool.name)).toEqual(["create_pr"]);
  });

  it("handles a mixed diff (added + removed + mutated + unchanged)", () => {
    const newSnap = { ...baseSnapshot, description: "Renamed" };
    const diff = diffPins(
      [descriptor("alpha"), descriptor("beta", newSnap), descriptor("gamma")], // alpha unchanged, beta mutated, gamma added
      [pin("alpha"), pin("beta"), pin("delta")], // delta removed
    );
    expect(diff.added.map((t) => t.name)).toEqual(["gamma"]);
    expect(diff.removed).toEqual(["delta"]);
    expect(diff.mutated.map((m) => m.tool.name)).toEqual(["beta"]);
    expect(diff.unchanged.map((p) => p.toolName)).toEqual(["alpha"]);
  });
});
