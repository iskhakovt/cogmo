import { describe, expect, it } from "vitest";
import { planGateEmission } from "./plan-gate.js";

describe("planGateEmission", () => {
  const minted = new Date("2026-09-23T12:00:00.000Z");

  it("a fresh approval carries the timestamp the caller minted", () => {
    expect(planGateEmission({ kind: "approved", conversationId: "c-1" }, minted)).toEqual({
      approvedAt: minted.toISOString(),
    });
  });

  it("an existing stamp still owes an emit, carrying the row's own timestamp", () => {
    // The recovery case: an earlier attempt committed the stamp and lost its
    // follow-through. Withholding the emit here strands the task, because it
    // is the only trigger of `coding-task-execute`.
    const stored = new Date("2026-09-23T09:00:00.000Z");
    expect(planGateEmission({ kind: "already_approved", approvedAt: stored }, minted)).toEqual({
      approvedAt: stored.toISOString(),
    });
  });

  it("owes nothing once the task has left awaiting_approval", () => {
    expect(planGateEmission({ kind: "not_pending", status: "cancelled" }, minted)).toBeNull();
    expect(planGateEmission({ kind: "not_found" }, minted)).toBeNull();
  });
});
