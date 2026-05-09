/**
 * `Transport.skills.{list, disable, enable}` — operator-facing skill
 * lifecycle surface used by `/skills`, `/disable`, `/enable` in the
 * Telegram adapter. Identity check, error mapping, and idempotency are
 * the meaningful contracts; the underlying SkillRunner / SkillStore are
 * mocked.
 */

import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { inboundArrived } from "../inngest/events.js";
import type {
  DeregisterResult,
  EnableResult,
  SkillRunner,
  SkillSummary,
} from "../skills/runner.js";
import type { SkillRow, SkillStore } from "../skills/store/index.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { TransportStore } from "./store/index.js";
import { createTransport } from "./transport.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const KNOWN_HANDLE = "tg-987";
const UNKNOWN_HANDLE = "tg-impostor";
const USER_ID = "019d0000-0000-7000-8000-000000000001";

function makeTransportStore(): TransportStore {
  const ts = mockTransportStore();
  // Allowlist `KNOWN_HANDLE` only; impostors fall through to `undefined`.
  vi.mocked(ts.resolveUser).mockImplementation(async (_tx, _channelId, handle) =>
    handle === KNOWN_HANDLE ? { userId: USER_ID } : undefined,
  );
  return ts;
}

function makeSkillRow(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "019d0000-0000-7000-8000-000000000010",
    name: "echo",
    tier: "wasm",
    riskTier: "auto",
    effects: [],
    schedule: null,
    gitSha: "abcdef0abcdef0abcdef0abcdef0abcdef0abcd0",
    inputs: { type: "object", properties: {} },
    outputs: null,
    disabled: false,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeTransport(opts: {
  runner?: SkillRunner;
  store?: SkillStore;
  agentStore?: AgentStore;
  transportStore?: TransportStore;
}) {
  const { runner, store } = opts;
  const inngest = { send: vi.fn().mockResolvedValue(undefined) } as unknown as Inngest;
  return createTransport({
    channelId: "ch-1",
    defaultUserId: USER_ID,
    defaultProfileId: "019d0000-0000-7000-8000-000000000099",
    runInTx: fakeRunInTx,
    transportStore: opts.transportStore ?? makeTransportStore(),
    agentStore: opts.agentStore ?? mockAgentStore(),
    ...(runner !== undefined && { skillRunner: runner }),
    ...(store !== undefined && { skillStore: store }),
    inngest,
    inboundArrived,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: 60_000,
  });
}

describe("Transport.skills.list", () => {
  it("returns enabled + disabled rows from runner.listAll", async () => {
    const runner = mock<SkillRunner>();
    runner.listAll.mockResolvedValue([
      {
        name: "alpha",
        tier: "wasm",
        riskTier: "auto",
        disabled: false,
        gitSha: "111",
      } satisfies SkillSummary,
      {
        name: "beta",
        tier: "container",
        riskTier: "approve",
        disabled: true,
        gitSha: "222",
      } satisfies SkillSummary,
    ]);
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.list(KNOWN_HANDLE);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([
      { name: "alpha", tier: "wasm", riskTier: "auto", disabled: false, gitSha: "111" },
      { name: "beta", tier: "container", riskTier: "approve", disabled: true, gitSha: "222" },
    ]);
  });

  it("rejects unknown caller with identity_rejected", async () => {
    const transport = makeTransport({
      runner: mock<SkillRunner>(),
      store: mock<SkillStore>(),
    });
    const result = await transport.skills.list(UNKNOWN_HANDLE);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns skills_disabled when runner is unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.skills.list(KNOWN_HANDLE);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "skills_disabled" });
  });
});

describe("Transport.skills.disable", () => {
  it("maps runner.deregister=deregistered → ok({name})", async () => {
    const runner = mock<SkillRunner>();
    runner.deregister.mockResolvedValue({
      kind: "deregistered",
      name: "echo",
    } satisfies DeregisterResult);
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.disable(KNOWN_HANDLE, "echo");
    expect(result._unsafeUnwrap()).toEqual({ name: "echo" });
    expect(runner.deregister).toHaveBeenCalledWith({ name: "echo" });
  });

  it("maps runner.deregister=rejected:not_found → err(skill_not_found)", async () => {
    const runner = mock<SkillRunner>();
    runner.deregister.mockResolvedValue({
      kind: "rejected",
      name: "ghost",
      reason: "not_found",
    } satisfies DeregisterResult);
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.disable(KNOWN_HANDLE, "ghost");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "skill_not_found", name: "ghost" });
  });

  it("rejects unknown caller before calling runner", async () => {
    const runner = mock<SkillRunner>();
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.disable(UNKNOWN_HANDLE, "echo");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(runner.deregister).not.toHaveBeenCalled();
  });

  it("rethrows infrastructure errors (DB / network) — Result wraps domain failures only", async () => {
    // The runner returns Result<T, DeregisterFailureReason> for domain
    // states (skill not found). Infrastructure errors (DB outage,
    // store throw) still escape via Promise rejection — the transport
    // contract is "domain failures are Result, infra failures are
    // 500-class throws upstream."
    const runner = mock<SkillRunner>();
    runner.deregister.mockRejectedValue(new Error("connection refused"));
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    await expect(transport.skills.disable(KNOWN_HANDLE, "echo")).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe("Transport.skills.enable", () => {
  it("maps runner.enable=enabled → ok({alreadyEnabled:false})", async () => {
    const runner = mock<SkillRunner>();
    runner.enable.mockResolvedValue({
      kind: "enabled",
      name: "echo",
      gitSha: "abc",
    } satisfies EnableResult);
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.enable(KNOWN_HANDLE, "echo");
    expect(result._unsafeUnwrap()).toEqual({ name: "echo", alreadyEnabled: false });
  });

  it("maps runner.enable=already_enabled → ok({alreadyEnabled:true})", async () => {
    const runner = mock<SkillRunner>();
    runner.enable.mockResolvedValue({
      kind: "already_enabled",
      name: "echo",
      gitSha: "abc",
    } satisfies EnableResult);
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.enable(KNOWN_HANDLE, "echo");
    expect(result._unsafeUnwrap()).toEqual({ name: "echo", alreadyEnabled: true });
  });

  it("maps runner.enable=rejected:not_found → err(skill_not_found)", async () => {
    const runner = mock<SkillRunner>();
    runner.enable.mockResolvedValue({
      kind: "rejected",
      name: "ghost",
      reason: "not_found",
    } satisfies EnableResult);
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.enable(KNOWN_HANDLE, "ghost");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "skill_not_found", name: "ghost" });
  });

  it("maps runner.enable=rejected:no_live_deploy → err(skill_no_live_deploy)", async () => {
    const runner = mock<SkillRunner>();
    runner.enable.mockResolvedValue({
      kind: "rejected",
      name: "denied-skill",
      reason: "no_live_deploy",
    } satisfies EnableResult);
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.enable(KNOWN_HANDLE, "denied-skill");
    expect(result._unsafeUnwrapErr()).toEqual({
      code: "skill_no_live_deploy",
      name: "denied-skill",
    });
  });

  it("rejects unknown caller before calling runner", async () => {
    const runner = mock<SkillRunner>();
    const transport = makeTransport({ runner, store: mock<SkillStore>() });

    const result = await transport.skills.enable(UNKNOWN_HANDLE, "echo");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(runner.enable).not.toHaveBeenCalled();
  });

  it("returns skills_disabled when runner is unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.skills.enable(KNOWN_HANDLE, "echo");
    expect(result._unsafeUnwrapErr()).toEqual({ code: "skills_disabled" });
  });
});
