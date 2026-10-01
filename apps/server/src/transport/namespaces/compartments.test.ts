import { err } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createCompartments } from "./compartments.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function setup(overrides?: {
  transportStore?: ReturnType<typeof mockTransportStore>;
  agentStore?: ReturnType<typeof mockAgentStore>;
}) {
  const transportStore = overrides?.transportStore ?? mockTransportStore();
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const compartments = createCompartments({
    channelId: "ch-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
  });
  return { compartments, transportStore, agentStore };
}

describe("compartments", () => {
  it("list scopes to the resolved userId", async () => {
    const listCustomCompartments = vi.fn().mockResolvedValue([
      {
        id: "cc-1",
        userId: "user-1",
        name: "dnd",
        description: "campaign notes",
        createdAt: new Date("2026-05-09T12:00:00Z"),
      },
    ]);
    const agentStore = mockAgentStore({ listCustomCompartments });
    const { compartments } = setup({ agentStore });
    const res = await compartments.list("handle");
    expect(res._unsafeUnwrap()).toHaveLength(1);
    expect(listCustomCompartments).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("create maps invalid_name to compartment_name_invalid", async () => {
    const agentStore = mockAgentStore({
      createCustomCompartment: vi
        .fn()
        .mockResolvedValue(err({ kind: "invalid_name", name: "Bad Name", subject: "compartment" })),
    });
    const { compartments } = setup({ agentStore });
    const res = await compartments.create("handle", {
      name: "Bad Name",
      description: "x",
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "compartment_name_invalid",
      name: "Bad Name",
    });
  });

  it("create maps reserved-name error to compartment_name_reserved", async () => {
    const agentStore = mockAgentStore({
      createCustomCompartment: vi
        .fn()
        .mockResolvedValue(err({ kind: "compartment_name_reserved", name: "personal" })),
    });
    const { compartments } = setup({ agentStore });
    const res = await compartments.create("handle", {
      name: "personal",
      description: "x",
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "compartment_name_reserved",
      name: "personal",
    });
  });

  it("create maps cap-exceeded error to compartment_cap_exceeded", async () => {
    const agentStore = mockAgentStore({
      createCustomCompartment: vi
        .fn()
        .mockResolvedValue(err({ kind: "compartment_cap_exceeded", limit: 10, current: 10 })),
    });
    const { compartments } = setup({ agentStore });
    const res = await compartments.create("handle", {
      name: "overflow",
      description: "x",
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "compartment_cap_exceeded",
      limit: 10,
      current: 10,
    });
  });

  it("create maps compartment_name_taken through", async () => {
    const agentStore = mockAgentStore({
      createCustomCompartment: vi
        .fn()
        .mockResolvedValue(err({ kind: "compartment_name_taken", name: "dnd" })),
    });
    const { compartments } = setup({ agentStore });
    const res = await compartments.create("handle", {
      name: "dnd",
      description: "x",
    });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "compartment_name_taken", name: "dnd" });
  });

  it("delete returns compartment_not_found when no row matches", async () => {
    const agentStore = mockAgentStore({
      deleteCustomCompartment: vi.fn().mockResolvedValue({ deleted: false }),
    });
    const { compartments } = setup({ agentStore });
    const res = await compartments.delete("handle", "no-such");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "compartment_not_found", name: "no-such" });
  });

  it("delete happy path returns ok and forwards (userId, name)", async () => {
    const deleteCustomCompartment = vi.fn().mockResolvedValue({ deleted: true });
    const agentStore = mockAgentStore({ deleteCustomCompartment });
    const { compartments } = setup({ agentStore });
    const res = await compartments.delete("handle", "dnd");
    expect(res.isOk()).toBe(true);
    expect(deleteCustomCompartment).toHaveBeenCalledWith(expect.anything(), "user-1", "dnd");
  });
});
