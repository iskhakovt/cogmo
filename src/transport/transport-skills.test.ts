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
import type { SkillDeployRow, SkillStore } from "../skills/store/index.js";
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

function makeTransport(opts: {
  runner?: SkillRunner;
  store?: SkillStore;
  agentStore?: AgentStore;
  transportStore?: TransportStore;
}) {
  const { runner, store } = opts;
  const inngest = mock<Inngest>();
  inngest.send.mockResolvedValue({ ids: [] });
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

/**
 * `approveDeploy` / `denyDeploy` are the lifecycle pair backing the
 * skills-approval inline keyboard in the Telegram adapter. Both perform a
 * pre-check against `SkillStore.getDeployById` to produce precise error
 * codes ahead of the runner call; the test matrix covers each branch in
 * isolation. The store is mocked because the contract under test is the
 * transport-layer mapping, not the SQL.
 */

const PENDING_ID = "019d0000-0000-7000-8000-000000000020";
const SKILL_ID = "019d0000-0000-7000-8000-000000000021";

function makeDeployRow(overrides: Partial<SkillDeployRow> = {}): SkillDeployRow {
  return {
    id: PENDING_ID,
    skillId: SKILL_ID,
    gitSha: "abcdef0abcdef0abcdef0abcdef0abcdef0abcd0",
    priorGitSha: null,
    riskTier: "approve",
    status: "pending_approval",
    approvedBy: null,
    classifierLog: {
      classifier_version: "stub-0",
      risk_tier: "approve",
      declared_effects: [],
      detected_effects: [],
      declared_secrets: [],
      validation_errors: [],
    },
    createdAt: new Date("2026-05-01T00:00:00Z"),
    resolvedAt: null,
    ...overrides,
  };
}

describe("Transport.skills.approveDeploy", () => {
  it("happy path: pending → runner.approveDeploy → ok({pendingId, skillName, gitSha})", async () => {
    const runner = mock<SkillRunner>();
    runner.approveDeploy.mockResolvedValue({
      name: "echo",
      riskTier: "approve",
      status: "live",
      gitSha: "1111111111111111111111111111111111111111",
    });
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(makeDeployRow());
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.approveDeploy(PENDING_ID, KNOWN_HANDLE);

    expect(result._unsafeUnwrap()).toEqual({
      pendingId: PENDING_ID,
      skillName: "echo",
      gitSha: "1111111111111111111111111111111111111111",
    });
    expect(runner.approveDeploy).toHaveBeenCalledWith({
      pendingId: PENDING_ID,
      approvedBy: KNOWN_HANDLE,
    });
  });

  it("returns skills_disabled when runner/store are unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.skills.approveDeploy(PENDING_ID, KNOWN_HANDLE);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "skills_disabled" });
  });

  it("rejects unknown caller before any store/runner call", async () => {
    const runner = mock<SkillRunner>();
    const store = mock<SkillStore>();
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.approveDeploy(PENDING_ID, UNKNOWN_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(store.getDeployById).not.toHaveBeenCalled();
    expect(runner.approveDeploy).not.toHaveBeenCalled();
  });

  it("returns skill_deploy_not_found when getDeployById returns undefined", async () => {
    const runner = mock<SkillRunner>();
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(undefined);
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.approveDeploy(PENDING_ID, KNOWN_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "skill_deploy_not_found",
      pendingId: PENDING_ID,
    });
    expect(runner.approveDeploy).not.toHaveBeenCalled();
  });

  it("returns skill_deploy_not_pending when status is already resolved", async () => {
    const runner = mock<SkillRunner>();
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(makeDeployRow({ status: "live" }));
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.approveDeploy(PENDING_ID, KNOWN_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "skill_deploy_not_pending",
      pendingId: PENDING_ID,
      status: "live",
    });
    expect(runner.approveDeploy).not.toHaveBeenCalled();
  });

  it("maps runner result status=rejected → skill_deploy_register_failed with reason", async () => {
    // The runner can race past the pre-check (deploy resolved between the
    // getDeployById read and the approveDeploy call). The transport
    // forwards the first runner-reported error message verbatim so the
    // toast text is useful.
    const runner = mock<SkillRunner>();
    runner.approveDeploy.mockResolvedValue({
      name: "echo",
      riskTier: "approve",
      status: "rejected",
      gitSha: "abc",
      errors: ["non_fast_forward_at_approve_time", "lost the race"],
    });
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(makeDeployRow());
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.approveDeploy(PENDING_ID, KNOWN_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "skill_deploy_register_failed",
      pendingId: PENDING_ID,
      reason: "non_fast_forward_at_approve_time",
    });
  });

  it("synthesises a reason when runner returned a non-live status with no errors", async () => {
    // Defence-in-depth: if a runner ever returns `status: "no_op"` or
    // `"pending_approval"` here (theoretically impossible for an approve
    // path), the transport must still produce a non-empty toast.
    const runner = mock<SkillRunner>();
    runner.approveDeploy.mockResolvedValue({
      name: "echo",
      riskTier: "approve",
      status: "no_op",
      gitSha: "abc",
    });
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(makeDeployRow());
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.approveDeploy(PENDING_ID, KNOWN_HANDLE);

    const e = result._unsafeUnwrapErr();
    expect(e.code).toBe("skill_deploy_register_failed");
    if (e.code === "skill_deploy_register_failed") {
      expect(e.reason).toMatch(/no_op/);
    }
  });
});

describe("Transport.skills.denyDeploy", () => {
  it("happy path: pending → runner.denyDeploy → ok({pendingId})", async () => {
    const runner = mock<SkillRunner>();
    runner.denyDeploy.mockResolvedValue(undefined);
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(makeDeployRow());
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.denyDeploy(PENDING_ID, KNOWN_HANDLE);

    expect(result._unsafeUnwrap()).toEqual({ pendingId: PENDING_ID });
    expect(runner.denyDeploy).toHaveBeenCalledWith({ pendingId: PENDING_ID });
  });

  it("forwards optional reason when provided", async () => {
    const runner = mock<SkillRunner>();
    runner.denyDeploy.mockResolvedValue(undefined);
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(makeDeployRow());
    const transport = makeTransport({ runner, store });

    await transport.skills.denyDeploy(PENDING_ID, KNOWN_HANDLE, "looks unsafe");

    expect(runner.denyDeploy).toHaveBeenCalledWith({
      pendingId: PENDING_ID,
      reason: "looks unsafe",
    });
  });

  it("returns skills_disabled when runner/store are unwired", async () => {
    const transport = makeTransport({});
    const result = await transport.skills.denyDeploy(PENDING_ID, KNOWN_HANDLE);
    expect(result._unsafeUnwrapErr()).toEqual({ code: "skills_disabled" });
  });

  it("rejects unknown caller before any store/runner call", async () => {
    const runner = mock<SkillRunner>();
    const store = mock<SkillStore>();
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.denyDeploy(PENDING_ID, UNKNOWN_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(store.getDeployById).not.toHaveBeenCalled();
    expect(runner.denyDeploy).not.toHaveBeenCalled();
  });

  it("returns skill_deploy_not_found when the deploy row is gone", async () => {
    const runner = mock<SkillRunner>();
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(undefined);
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.denyDeploy(PENDING_ID, KNOWN_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "skill_deploy_not_found",
      pendingId: PENDING_ID,
    });
    expect(runner.denyDeploy).not.toHaveBeenCalled();
  });

  it("returns skill_deploy_not_pending on a re-tap of an already-denied row", async () => {
    // The store's denyPendingDeploy is itself idempotent (it silently
    // skips already-resolved rows), but this layer wants a precise toast
    // — a second tap should say "already resolved", not "denied".
    const runner = mock<SkillRunner>();
    const store = mock<SkillStore>();
    store.getDeployById.mockResolvedValue(makeDeployRow({ status: "denied" }));
    const transport = makeTransport({ runner, store });

    const result = await transport.skills.denyDeploy(PENDING_ID, KNOWN_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "skill_deploy_not_pending",
      pendingId: PENDING_ID,
      status: "denied",
    });
    expect(runner.denyDeploy).not.toHaveBeenCalled();
  });
});
