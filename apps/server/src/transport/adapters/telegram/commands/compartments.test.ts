import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { ProfileDialogs } from "../profile-dialog.js";
import { handleCompartments } from "./compartments.js";
import { mkCtx, transportWith } from "./test-fixtures.js";

function _mkDialogs(): ProfileDialogs {
  return new ProfileDialogs();
}

describe("handleCompartments", () => {
  it("bare /compartments lists registered customs", async () => {
    const list = vi.fn().mockResolvedValue(
      ok([
        {
          id: "cc-1",
          userId: "u-1",
          name: "dnd",
          description: "tabletop campaign notes",
          createdAt: new Date("2026-05-09T12:00:00Z"),
        },
        {
          id: "cc-2",
          userId: "u-1",
          name: "music",
          description: "music production sessions",
          createdAt: new Date("2026-05-09T12:00:00Z"),
        },
      ]),
    );
    const transport = transportWith({ compartments: { list } });
    const ctx = mkCtx();
    await handleCompartments(transport, ctx);
    expect(list).toHaveBeenCalledWith("1");
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("dnd");
    expect(reply).toContain("tabletop campaign notes");
    expect(reply).toContain("music");
    // Always remind the operator the core six exist alongside customs.
    expect(reply).toContain("personal");
    expect(reply).toContain("misc");
  });

  it("explicit /compartments list uses the same path", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ compartments: { list } });
    await handleCompartments(transport, mkCtx("list"));
    expect(list).toHaveBeenCalled();
  });

  it("bare /compartments with empty registry surfaces the bootstrap hint and the core list", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ compartments: { list } });
    const ctx = mkCtx();
    await handleCompartments(transport, ctx);
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("/compartments add");
    expect(reply).toContain("personal");
  });

  it("/compartments add <name> <desc> calls compartments.create", async () => {
    const create = vi.fn().mockResolvedValue(
      ok({
        id: "cc-1",
        userId: "u-1",
        name: "dnd",
        description: "tabletop campaign notes",
        createdAt: new Date("2026-05-09T12:00:00Z"),
      }),
    );
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add dnd tabletop campaign notes");
    await handleCompartments(transport, ctx);
    expect(create).toHaveBeenCalledWith("1", {
      name: "dnd",
      description: "tabletop campaign notes",
    });
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain('Registered compartment "dnd"');
    expect(reply).toContain("compartment:dnd");
  });

  it("/compartments add with no args replies with usage", async () => {
    const create = vi.fn();
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add");
    await handleCompartments(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });

  it("/compartments add with name but no description replies with usage", async () => {
    const create = vi.fn();
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add dnd");
    await handleCompartments(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });

  it("/compartments add surfaces compartment_name_reserved with the core-list nudge", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(err({ code: "compartment_name_reserved", name: "personal" }));
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add personal redefined");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"personal" is a core compartment');
  });

  it("/compartments add surfaces compartment_cap_exceeded with the cap numbers", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(err({ code: "compartment_cap_exceeded", limit: 10, current: 10 }));
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add overflow desc");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("(10/10)");
  });

  it("/compartments add surfaces compartment_name_taken", async () => {
    const create = vi.fn().mockResolvedValue(err({ code: "compartment_name_taken", name: "dnd" }));
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add dnd desc");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"dnd" already exists');
  });

  it("/compartments rm <name> calls compartments.delete and notes the forward-only guarantee", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ compartments: { delete: del } });
    const ctx = mkCtx("rm dnd");
    await handleCompartments(transport, ctx);
    expect(del).toHaveBeenCalledWith("1", "dnd");
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain('"dnd" removed');
    // Forward-only is the surprising part for the operator — surface it.
    expect(reply).toContain("Forward-only");
  });

  it("/compartments remove and /compartments delete both alias to rm", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ compartments: { delete: del } });
    await handleCompartments(transport, mkCtx("remove dnd"));
    await handleCompartments(transport, mkCtx("delete dnd"));
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("/compartments rm with no args replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("rm");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });

  it("/compartments rm surfaces compartment_not_found", async () => {
    const del = vi.fn().mockResolvedValue(err({ code: "compartment_not_found", name: "no-such" }));
    const transport = transportWith({ compartments: { delete: del } });
    const ctx = mkCtx("rm no-such");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No custom compartment named "no-such"');
  });

  it("bare /compartments surfaces identity_rejected via errorMessage", async () => {
    const list = vi.fn().mockResolvedValue(err({ code: "identity_rejected" }));
    const transport = transportWith({ compartments: { list } });
    const ctx = mkCtx();
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("not authorized");
  });

  it("unknown subcommand replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("frobnicate");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });
});
