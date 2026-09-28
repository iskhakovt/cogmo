import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { AgentStore } from "../agent/store/index.js";
import type { BootstrapLock } from "../db/bootstrap-lock.js";
import type { Database } from "../db/index.js";
import { migratePerFile } from "../db/migrate-per-file.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { ensureFalImageDefaults, ensureWebChannel } from "../setup/seed.js";
import { bootstrapSkillsRepo, ensureSkillsCodingRepo } from "../skills/repo.js";
import { fakeRunInTx } from "../test/factories.js";
import type { TransportStore } from "../transport/store/index.js";
import { checkUuidv7 } from "./checks.js";
import { prepareDataLayer, seedRuntimeDefaults } from "./locked-bootstrap.js";

vi.mock("../db/migrate-per-file.js", () => ({ migratePerFile: vi.fn() }));
vi.mock("./checks.js", () => ({ checkUuidv7: vi.fn() }));
vi.mock("../skills/repo.js", () => ({
  bootstrapSkillsRepo: vi.fn(),
  ensureSkillsCodingRepo: vi.fn(),
}));
vi.mock("../setup/seed.js", () => ({
  ensureFalImageDefaults: vi.fn(),
  ensureWebChannel: vi.fn(),
}));

/** Whether each step ran while the lock was held, keyed by step. */
let heldDuring: Record<string, boolean>;
let held: boolean;

const lock: BootstrapLock = async (fn) => {
  held = true;
  try {
    return await fn();
  } finally {
    held = false;
  }
};

function record(step: string): void {
  heldDuring[step] = held;
}

beforeEach(() => {
  heldDuring = {};
  held = false;
  vi.mocked(migratePerFile).mockImplementation(async () => record("migrate"));
  vi.mocked(checkUuidv7).mockImplementation(async () => record("uuidv7"));
  vi.mocked(bootstrapSkillsRepo).mockImplementation(async ({ path }) => {
    record("skills repo");
    return { initialized: false, path };
  });
  vi.mocked(ensureSkillsCodingRepo).mockImplementation(async (_deps, { skillsRepoPath }) => {
    record("skills row");
    return { kind: "skipped_no_origin", localPath: skillsRepoPath };
  });
  vi.mocked(ensureFalImageDefaults).mockImplementation(async () => {
    record("fal defaults");
    return { skipped: true, reason: "no_fal_secret" };
  });
  vi.mocked(ensureWebChannel).mockImplementation(async () => record("web channel"));
});

describe("prepareDataLayer", () => {
  it("migrates and bootstraps the skills repo under the bootstrap lock", async () => {
    await prepareDataLayer(
      {
        bootstrapLock: lock,
        db: mock<Database>(),
        runInTx: fakeRunInTx,
        codingStore: mock<CodingStore>(),
      },
      { skillsRepoPath: "/var/lib/cogmo/skills" },
    );

    expect(heldDuring).toEqual({
      migrate: true,
      uuidv7: true,
      "skills repo": true,
      "skills row": true,
    });
  });
});

describe("seedRuntimeDefaults", () => {
  it("seeds the fal catalog and the web channel under the bootstrap lock", async () => {
    await seedRuntimeDefaults(
      {
        bootstrapLock: lock,
        runInTx: fakeRunInTx,
        agentStore: mock<AgentStore>(),
        transportStore: mock<TransportStore>(),
        secretsStore: mock<SecretsStore>(),
      },
      { userId: "user-1", envFalApiKey: "fal-key" },
    );

    expect(heldDuring).toEqual({ "fal defaults": true, "web channel": true });
    expect(ensureFalImageDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ envFalApiKey: "fal-key" }),
    );
    expect(ensureWebChannel).toHaveBeenCalledWith(fakeRunInTx, expect.anything(), "user-1");
  });
});
