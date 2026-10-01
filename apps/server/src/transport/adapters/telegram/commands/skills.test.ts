import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mkCtx, transportWith } from "../../../../test/telegram/command-fixtures.js";
import { handleDisable, handleEnable, handleSkills } from "./skills.js";

describe("handleSkills", () => {
  it("renders one line per skill, with disabled marker", async () => {
    const transport = transportWith({
      skills: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              name: "alpha",
              tier: "wasm",
              riskTier: "auto",
              disabled: false,
              gitSha: "1234567abcdef",
            },
            {
              name: "beta",
              tier: "container",
              riskTier: "approve",
              disabled: true,
              gitSha: "fedcba9012345",
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleSkills(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("alpha [wasm/auto] @ 1234567");
    expect(reply).toContain("beta [container/approve] @ fedcba9 (disabled)");
  });

  it("nudges the user when there are no skills", async () => {
    const transport = transportWith({
      skills: { list: vi.fn().mockResolvedValue(ok([])) },
    });
    const ctx = mkCtx();
    await handleSkills(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("No skills registered");
  });

  it("maps skills_disabled to a friendly message", async () => {
    const transport = transportWith({
      skills: { list: vi.fn().mockResolvedValue(err({ code: "skills_disabled" })) },
    });
    const ctx = mkCtx();
    await handleSkills(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Skills runtime is unavailable");
  });
});

describe("handleDisable", () => {
  it("requires a name argument", async () => {
    const transport = transportWith();
    const ctx = mkCtx();
    await handleDisable(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Usage: /disable <name>");
  });

  it("calls transport.skills.disable and confirms success", async () => {
    const disable = vi.fn().mockResolvedValue(ok({ name: "echo" }));
    const transport = transportWith({ skills: { disable } });
    const ctx = mkCtx("echo");
    await handleDisable(transport, ctx);
    expect(disable).toHaveBeenCalledWith("1", "echo");
    expect(ctx.reply).toHaveBeenCalledWith('Skill "echo" disabled.');
  });

  it("renders skill_not_found with a friendly message that hints at /skills", async () => {
    const transport = transportWith({
      skills: {
        disable: vi.fn().mockResolvedValue(err({ code: "skill_not_found", name: "ghost" })),
      },
    });
    const ctx = mkCtx("ghost");
    await handleDisable(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No skill named "ghost"');
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("/skills");
  });
});

describe("handleEnable", () => {
  it("requires a name argument", async () => {
    const transport = transportWith();
    const ctx = mkCtx();
    await handleEnable(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Usage: /enable <name>");
  });

  it("calls transport.skills.enable and confirms success", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ name: "echo", alreadyEnabled: false }));
    const transport = transportWith({ skills: { enable } });
    const ctx = mkCtx("echo");
    await handleEnable(transport, ctx);
    // The chat is passed so the enabler's own conversation can supply a profile.
    expect(enable).toHaveBeenCalledWith("1", "echo", "42");
    expect(ctx.reply).toHaveBeenCalledWith('Skill "echo" enabled.');
  });

  it("says a scheduled skill now runs as the enabler", async () => {
    const enable = vi
      .fn()
      .mockResolvedValue(ok({ name: "echo", alreadyEnabled: false, schedule: "0 9 * * *" }));
    const transport = transportWith({ skills: { enable } });
    const ctx = mkCtx("echo");
    await handleEnable(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      'Skill "echo" enabled. Its schedule 0 9 * * * now runs as you.',
    );
  });

  it("reports idempotent already-enabled state without re-enabling", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ name: "echo", alreadyEnabled: true }));
    const transport = transportWith({ skills: { enable } });
    const ctx = mkCtx("echo");
    await handleEnable(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Skill "echo" is already enabled.');
  });

  it("renders skill_no_live_deploy with a re-register hint", async () => {
    const transport = transportWith({
      skills: {
        enable: vi
          .fn()
          .mockResolvedValue(err({ code: "skill_no_live_deploy", name: "denied-skill" })),
      },
    });
    const ctx = mkCtx("denied-skill");
    await handleEnable(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain('"denied-skill"');
    expect(reply).toContain("no live deploy");
    expect(reply).toContain("re-register");
  });
});
