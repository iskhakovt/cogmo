import { describe, expect, it } from "vitest";
import { type MockProxy, mock } from "vitest-mock-extended";
import type { Transactor } from "../db/index.js";
import { listAllSkills } from "./listing.js";
import type { SkillDeployRow, SkillRow, SkillStore } from "./store/index.js";

const FAKE_TX = { __mockTx: true } as never;

const SHA_LIVE = "a".repeat(40);
const SHA_PENDING = "b".repeat(40);

function skillRow(overrides: Partial<SkillRow> = {}): SkillRow {
  return {
    id: "skill-1",
    name: "echo",
    tier: "wasm",
    riskTier: "notify",
    effects: [],
    schedule: null,
    nextRunAt: null,
    runAsUserId: null,
    runAsProfileId: null,
    lastFiredAt: null,
    gitSha: SHA_LIVE,
    lockfileHash: null,
    inputs: { type: "object", properties: {} },
    outputs: null,
    disabled: false,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

function pendingDeploy(overrides: Partial<SkillDeployRow> = {}): SkillDeployRow {
  return {
    id: "deploy-1",
    skillId: "skill-1",
    gitSha: SHA_PENDING,
    priorGitSha: SHA_LIVE,
    riskTier: "approve",
    status: "pending_approval",
    approvedBy: null,
    classifierLog: {
      classifier_version: "ast-2",
      risk_tier: "approve",
      declared_effects: ["sends_email"],
      detected_effects: [],
      declared_secrets: [],
      declared_dependencies: [],
      validation_errors: [],
      reasons: ["approve_gating_effect"],
      declared_network: null,
    },
    createdAt: new Date("2026-11-02T00:00:00Z"),
    resolvedAt: null,
    ...overrides,
  };
}

/** A store and a transactor that counts how many transactions the listing opens. */
function setup(): {
  store: MockProxy<SkillStore>;
  runInTx: Transactor;
  txCount: () => number;
} {
  const store = mock<SkillStore>();
  let count = 0;
  const runInTx: Transactor = (cb) => {
    count += 1;
    return cb(FAKE_TX);
  };
  return { store, runInTx, txCount: () => count };
}

describe("listAllSkills", () => {
  const list = listAllSkills;
  const read = "listAllSkills" as const;
  it("attaches each skill's pending deploy and leaves the others null", async () => {
    const { store, runInTx } = setup();
    store[read].mockResolvedValue([
      skillRow(),
      skillRow({ id: "skill-2", name: "other", disabled: read === "listAllSkills" }),
    ]);
    store.listPendingDeploys.mockResolvedValue([pendingDeploy()]);

    const summaries = await list({ store, runInTx });

    expect(summaries).toEqual([
      {
        name: "echo",
        tier: "wasm",
        riskTier: "notify",
        disabled: false,
        gitSha: SHA_LIVE,
        pendingDeploy: { id: "deploy-1", gitSha: SHA_PENDING, priorGitSha: SHA_LIVE },
      },
      expect.objectContaining({ name: "other", pendingDeploy: null }),
    ]);
  });

  it("reads the skills and the pending deploys in one transaction", async () => {
    const { store, runInTx, txCount } = setup();
    store[read].mockResolvedValue([skillRow()]);
    store.listPendingDeploys.mockResolvedValue([]);

    await list({ store, runInTx });

    expect(txCount()).toBe(1);
    expect(store[read]).toHaveBeenCalledWith(FAKE_TX);
    expect(store.listPendingDeploys).toHaveBeenCalledWith(FAKE_TX);
  });

  it("shows the newest of two pending deploys for one skill", async () => {
    const { store, runInTx } = setup();
    store[read].mockResolvedValue([skillRow()]);
    store.listPendingDeploys.mockResolvedValue([
      pendingDeploy({ id: "deploy-old", gitSha: "c".repeat(40) }),
      pendingDeploy({ id: "deploy-new" }),
    ]);

    const [summary] = await list({ store, runInTx });

    expect(summary?.pendingDeploy).toEqual({
      id: "deploy-new",
      gitSha: SHA_PENDING,
      priorGitSha: SHA_LIVE,
    });
  });

  it("ignores a pending deploy whose skill is not in the listing", async () => {
    const { store, runInTx } = setup();
    store[read].mockResolvedValue([skillRow()]);
    store.listPendingDeploys.mockResolvedValue([pendingDeploy({ skillId: "skill-elsewhere" })]);

    const summaries = await list({ store, runInTx });

    expect(summaries.map((s) => s.pendingDeploy)).toEqual([null]);
  });
});
