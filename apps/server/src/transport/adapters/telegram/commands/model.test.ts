import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { handleModel } from "./model.js";
import { mkCtx, transportWith } from "./test-fixtures.js";

describe("handleModel", () => {
  it("lists models when called without arg", async () => {
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(
          ok({
            conversationId: "c1",
            profileId: "p1",
            profileName: "assistant",
            model: "gpt-4o",
          }),
        ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
      models: { list: vi.fn().mockResolvedValue(["gpt-4o", "claude-sonnet-4-6"]) },
    });
    const ctx = mkCtx();
    await handleModel(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("← current"));
  });

  it("updates active profile's model when arg supplied", async () => {
    const update = vi.fn().mockResolvedValue(ok({} as never));
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi
          .fn()
          .mockResolvedValue(
            ok({ conversationId: "c1", profileId: "p1", profileName: "assistant", model: "old" }),
          ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update,
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("gpt-4o");
    await handleModel(transport, ctx);
    // The handler passes `clearCooldownForConversation` so the model
    // update + cooldown clear land in one tx. See
    // design/agent-resilience.md → Clear triggers.
    expect(update).toHaveBeenCalledWith(
      "1",
      "p1",
      { model: "gpt-4o" },
      { clearCooldownForConversation: "c1" },
    );
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("set to gpt-4o"));
  });

  it("maps model_unavailable to friendly message", async () => {
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi
          .fn()
          .mockResolvedValue(
            ok({ conversationId: "c1", profileId: "p1", profileName: "a", model: "old" }),
          ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(err({ code: "model_unavailable", model: "bad" })),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("bad");
    await handleModel(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('"bad" isn\'t available'));
  });
});
