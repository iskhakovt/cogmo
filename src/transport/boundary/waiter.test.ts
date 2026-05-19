import { describe, expect, it } from "vitest";
import { inngest } from "../../inngest/client.js";
import { boundaryPendingEvent, boundaryResolvedEvent } from "../../inngest/events.js";
import { fakeRunInTx, mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createBoundaryWaiter } from "./waiter.js";

// End-to-end "sleep → wake → resolve-as-fresh" coverage is structurally
// equivalent to the janitor's orphan-recovery path (already tested in
// janitor.test.ts); the integration value is the resolveBoundary contract,
// which is unit-tested in resolve-boundary.test.ts. These tests pin the
// function wiring so a regression in trigger / idempotency / cancelOn
// shape — which would silently break the boundary lifecycle — is caught.
describe("createBoundaryWaiter", () => {
  it("pins the function configuration (trigger, idempotency, cancelOn)", () => {
    const fn = createBoundaryWaiter({
      runInTx: fakeRunInTx,
      transportStore: mockTransportStore(),
      agentStore: mockAgentStore(),
      inngest,
      defaultProfileId: "profile-default",
    });
    expect(fn.opts.id).toBe("boundary-waiter");
    expect(fn.opts.idempotency).toBe("event.data.boundaryId");
    expect(fn.opts.triggers).toEqual([boundaryPendingEvent]);
    // `cancelOn` matched on the same key as the idempotency dimension —
    // a button tap that wins the race emits `boundary/resolved` with
    // matching `data.boundaryId`, and the waiter's sleep wakes early.
    expect(fn.opts.cancelOn).toEqual([{ event: boundaryResolvedEvent, match: "data.boundaryId" }]);
  });
});
