import type { Transactor } from "../db/index.js";
import { logger } from "../logger.js";
import type { SkillSourceCache } from "./source-cache.js";
import type { SkillRiskTier, SkillRow, SkillStore, SkillTier } from "./store/index.js";
import type { SkillInputs } from "./types.js";

const log = logger.child({ component: "skills.runner" });

export interface SkillSummary {
  name: string;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  disabled: boolean;
  gitSha: string;
}

/**
 * The full per-skill descriptor needed to register the skill as an LLM tool.
 * Returned by {@link listToolDefs} so the orchestrator can rebuild the
 * per-turn tool list without re-reading git for each entry.
 */
export interface SkillToolDef {
  name: string;
  /**
   * From `SKILL.md` frontmatter. The first line of the body is appended when
   * present so the LLM-facing description picks up the human-readable
   * preamble too. Bounded ≤500 chars (manifest validator already caps).
   */
  description: string;
  /**
   * JSON Schema as declared in the manifest. Structurally compatible with
   * `JsonSchema` (in `src/llm/types.ts`) — both pin `type: "object"` and
   * permit extra keys via index signature — so the dynamic-tool-list builder
   * forwards it to the LLM without an `as unknown` cast.
   */
  inputs: SkillInputs;
  tier: SkillTier;
  riskTier: SkillRiskTier;
  gitSha: string;
}

/** What the listings read: the skill rows, and the source cache for tool descriptors. */
export interface ListingDeps {
  store: SkillStore;
  runInTx: Transactor;
  sourceCache: SkillSourceCache;
}

function rowToSummary(r: SkillRow): SkillSummary {
  return {
    name: r.name,
    tier: r.tier,
    riskTier: r.riskTier,
    disabled: r.disabled,
    gitSha: r.gitSha,
  };
}

/** Enabled skills, by name. */
export async function listSkills(
  deps: Pick<ListingDeps, "store" | "runInTx">,
): Promise<readonly SkillSummary[]> {
  const rows = await deps.runInTx((tx) => deps.store.listEnabledSkills(tx));
  return rows.map(rowToSummary);
}

/** Every skill, disabled ones included, by name. */
export async function listAllSkills(
  deps: Pick<ListingDeps, "store" | "runInTx">,
): Promise<readonly SkillSummary[]> {
  const rows = await deps.runInTx((tx) => deps.store.listAllSkills(tx));
  return rows.map(rowToSummary);
}

/** The enabled skills as LLM tool descriptors, skipping any whose source is unreadable. */
export async function listToolDefs(deps: ListingDeps): Promise<readonly SkillToolDef[]> {
  const rows = await deps.runInTx((tx) => deps.store.listEnabledSkills(tx));
  const defs: SkillToolDef[] = [];
  for (const row of rows) {
    try {
      const cached = await deps.sourceCache.load(row);
      defs.push({
        name: row.name,
        description: cached.manifest.description,
        inputs: row.inputs,
        tier: row.tier,
        riskTier: row.riskTier,
        gitSha: row.gitSha,
      });
    } catch (e) {
      // A skill row whose git source is unreadable shouldn't poison the
      // whole tool list — log and skip. Most likely cause: the repo was
      // moved/wiped between deploy and read; the user notices via the
      // missing tool and re-registers.
      log.warn(
        { skillName: row.name, gitSha: row.gitSha, err: e },
        "skipping skill in tool list — source unreadable",
      );
    }
  }
  return defs;
}
