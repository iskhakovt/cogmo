/**
 * `RegisterResult` builders for tests of what consumes a deploy outcome, and
 * the offline wasm host side a test's `SkillRunnerImpl` runs with.
 */

import { join } from "node:path";
import { ok } from "neverthrow";
import { vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { DeployFacts } from "../skills/deploy/deploy-facts.js";
import type { RegisterResult, SkillRunnerOptions } from "../skills/runner.js";
import type { WasmProbe, WasmSchemaImporter } from "../skills/worker-wasm/wasm.js";

type LiveResult = Extract<RegisterResult, { status: "live" }>;
type PendingResult = Extract<RegisterResult, { status: "pending_approval" }>;

export const FIXTURE_SKILL_ID = "019d0000-0000-7000-8000-0000000000ab";
export const FIXTURE_DEPLOY_ID = "019d0000-0000-7000-8000-0000000000cd";

/** A first deploy declaring nothing. */
export function deployFactsFixture(overrides: Partial<DeployFacts> = {}): DeployFacts {
  return {
    description: "Echoes its input back.",
    effects: { declared: [], detected: [] },
    hosts: [],
    secrets: [],
    dependencies: [],
    schedule: null,
    reasons: [],
    priorGitSha: null,
    ...overrides,
  };
}

export function liveRegisterResult(overrides: Partial<LiveResult> = {}): LiveResult {
  return {
    name: "echo",
    riskTier: "notify",
    status: "live",
    gitSha: "abc1234",
    skillId: FIXTURE_SKILL_ID,
    deployId: FIXTURE_DEPLOY_ID,
    facts: deployFactsFixture(),
    ...overrides,
  };
}

export function pendingRegisterResult(overrides: Partial<PendingResult> = {}): PendingResult {
  return {
    name: "notifier",
    riskTier: "approve",
    status: "pending_approval",
    gitSha: "abcdef0123456789",
    skillId: FIXTURE_SKILL_ID,
    deployId: FIXTURE_DEPLOY_ID,
    facts: deployFactsFixture({ effects: { declared: ["sends_message"], detected: [] } }),
    ...overrides,
  };
}

/**
 * The wasm tier without the network, its directories under `root`: a probe that
 * spawns no child and answers ok, a fetch that fails every request (so the
 * register's cache fill fails open and the probe is skipped), a resolver
 * that fetches nothing, and a schema importer that spawns no child and finds
 * no models, so register takes the frontmatter's schemas. A wasm skill with
 * no dependencies still runs in a real child; one whose lockfile needs
 * packages gets none, so a test that runs one passes the real resolver
 * instead.
 */
export function offlineWasm(
  root: string,
): Pick<SkillRunnerOptions, "pyodidePackageCacheDir" | "wasm"> {
  const probe = mock<WasmProbe>();
  probe.probeBuiltins.mockResolvedValue(ok());
  const schemaImporter = mock<WasmSchemaImporter>();
  schemaImporter.importSchemas.mockResolvedValue(ok({ inputs: null, outputs: null }));
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new TypeError("offline: wasm tests reach no network");
  });
  return {
    pyodidePackageCacheDir: join(root, ".pyodide-cache"),
    wasm: {
      wheelsRoot: join(root, ".pyodide-wheels"),
      childrenDir: join(root, ".wasm-children"),
      probe,
      fetchImpl,
      resolvePackages: async () => ok({ builtins: [], wheelDir: null }),
      schemaImporter,
    },
  };
}
