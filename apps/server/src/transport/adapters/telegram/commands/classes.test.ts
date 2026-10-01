import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { handleClasses } from "./classes.js";
import { mkCtx, transportWith } from "./test-fixtures.js";

describe("handleClasses", () => {
  it("rejects /classes add with reserved name 'clear' before calling Transport", async () => {
    const create = vi.fn().mockResolvedValue(ok({} as never));
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add clear something descriptive");
    await handleClasses(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"clear" is reserved');
  });

  it("rejects /classes add CLEAR (case-insensitive)", async () => {
    const create = vi.fn().mockResolvedValue(ok({} as never));
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add CLEAR description");
    await handleClasses(transport, ctx);
    expect(create).not.toHaveBeenCalled();
  });

  it("/classes add <name> <desc> with a normal name calls profileClasses.create", async () => {
    const create = vi.fn().mockResolvedValue(
      ok({
        id: "c-1",
        userId: "u-1",
        name: "intimate",
        description: "for emotional / relationship topics",
        createdAt: new Date("2026-04-16T12:00:00Z"),
      }),
    );
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add intimate for emotional / relationship topics");
    await handleClasses(transport, ctx);
    expect(create).toHaveBeenCalledWith("1", {
      name: "intimate",
      description: "for emotional / relationship topics",
    });
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('Registered class "intimate"');
  });

  it("/classes add with no args replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("add");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes add with name but missing description replies with usage", async () => {
    const create = vi.fn();
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add intimate");
    await handleClasses(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes add surfaces profile_class_name_taken from Transport", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(err({ code: "profile_class_name_taken", name: "intimate" }));
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add intimate desc");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"intimate" already exists');
  });

  it("bare /classes lists registered classes", async () => {
    const list = vi.fn().mockResolvedValue(
      ok([
        {
          id: "c-1",
          userId: "u-1",
          name: "intimate",
          description: "for emotional / relationship topics",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
        {
          id: "c-2",
          userId: "u-1",
          name: "general",
          description: "default for assistant-style profiles",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
      ]),
    );
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    expect(list).toHaveBeenCalledWith("1");
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("intimate");
    expect(reply).toContain("for emotional / relationship topics");
    expect(reply).toContain("general");
    // No restricted classes → no `(restricted)` marker, no legend.
    expect(reply).not.toContain("(restricted)");
  });

  it("/classes list annotates restricted classes and appends a legend", async () => {
    const list = vi.fn().mockResolvedValue(
      ok([
        {
          id: "c-1",
          userId: "u-1",
          name: "intimate",
          description: "for emotional / relationship topics",
          restricted: true,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
        {
          id: "c-2",
          userId: "u-1",
          name: "general",
          description: "default for assistant-style profiles",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
      ]),
    );
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    const reply = ctx.reply.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/intimate \(restricted\)/);
    expect(reply).not.toMatch(/general \(restricted\)/);
    expect(reply).toContain("readers must opt in");
  });

  it("explicit /classes list uses the same path", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx("list");
    await handleClasses(transport, ctx);
    expect(list).toHaveBeenCalled();
  });

  it("bare /classes with empty registry replies with the bootstrap hint", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("/classes add");
  });

  it("bare /classes surfaces identity_rejected via errorMessage", async () => {
    const list = vi.fn().mockResolvedValue(err({ code: "identity_rejected" }));
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("not authorized");
  });

  it("/classes rm <name> calls profileClasses.delete", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm intimate");
    await handleClasses(transport, ctx);
    expect(del).toHaveBeenCalledWith("1", "intimate", { confirm: false });
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"intimate" removed');
  });

  it("/classes rm lists the blocks it would delete and the command that confirms", async () => {
    const del = vi
      .fn()
      .mockResolvedValue(
        err({ code: "profile_class_has_blocks", keys: ["identity", "preferences"] }),
      );
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm game");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toBe(
      'Removing class "game" deletes its core-memory blocks: identity, preferences. ' +
        "To go ahead: /classes rm game confirm",
    );
  });

  it("/classes rm <name> confirm passes the confirmation", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { delete: del } });
    await handleClasses(transport, mkCtx("rm game confirm"));
    expect(del).toHaveBeenCalledWith("1", "game", { confirm: true });
  });

  it("/classes rm with a word other than confirm replies with usage", async () => {
    const del = vi.fn();
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm game now");
    await handleClasses(transport, ctx);
    expect(del).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes remove and /classes delete both alias to rm", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { delete: del } });
    await handleClasses(transport, mkCtx("remove intimate"));
    await handleClasses(transport, mkCtx("delete intimate"));
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("/classes rm with no args replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("rm");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes rm surfaces profile_class_in_use", async () => {
    const del = vi.fn().mockResolvedValue(err({ code: "profile_class_in_use", profileRefs: 2 }));
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm intimate");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("2 profile(s)");
  });

  it("/classes rm surfaces profile_class_not_found", async () => {
    const del = vi
      .fn()
      .mockResolvedValue(err({ code: "profile_class_not_found", name: "no-such" }));
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm no-such");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No profile class named "no-such"');
  });

  it("unknown subcommand replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("frobnicate");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes restrict <name> calls profileClasses.setRestricted with true", async () => {
    const setRestricted = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("restrict intimate");
    await handleClasses(transport, ctx);
    expect(setRestricted).toHaveBeenCalledWith("1", "intimate", true, { confirm: false });
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("marked restricted");
  });

  it("/classes unrestrict <name> calls profileClasses.setRestricted with false", async () => {
    const setRestricted = vi.fn().mockResolvedValue(ok({ overrideDeleted: false }));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("unrestrict intimate");
    await handleClasses(transport, ctx);
    expect(setRestricted).toHaveBeenCalledWith("1", "intimate", false, { confirm: false });
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("no longer restricted");
  });

  it("/classes unrestrict names the identity block it would delete and the command that confirms", async () => {
    const setRestricted = vi
      .fn()
      .mockResolvedValue(err({ code: "profile_class_has_blocks", keys: ["identity"] }));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("unrestrict game");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toBe(
      'Class "game" has its own identity block, which unrestricting deletes; the class then ' +
        "reads the shared one. To go ahead: /classes unrestrict game confirm",
    );
  });

  it("/classes unrestrict <name> confirm passes the confirmation and names the deleted override", async () => {
    const setRestricted = vi.fn().mockResolvedValue(ok({ overrideDeleted: true }));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("unrestrict game confirm");
    await handleClasses(transport, ctx);
    expect(setRestricted).toHaveBeenCalledWith("1", "game", false, { confirm: true });
    expect(ctx.reply.mock.calls[0]?.[0]).toBe(
      'Class "game" no longer restricted. Its own identity block was deleted, so it reads the ' +
        "shared one. Recall returns to open-by-default for this class.",
    );
  });

  it("/classes restrict takes no confirm", async () => {
    const setRestricted = vi.fn();
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("restrict game confirm");
    await handleClasses(transport, ctx);
    expect(setRestricted).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes restrict with no name replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("restrict");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes restrict surfaces profile_class_not_found", async () => {
    const setRestricted = vi
      .fn()
      .mockResolvedValue(err({ code: "profile_class_not_found", name: "no-such" }));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("restrict no-such");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No profile class named "no-such"');
  });
});
