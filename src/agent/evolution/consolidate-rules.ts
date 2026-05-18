/**
 * Rule consolidation — merges semantically similar steering rules.
 *
 * Triggered when active rule count exceeds the threshold (30).
 * An LLM groups similar rules and produces merged versions.
 * Old rules are atomically replaced via store.replaceRules().
 */

import * as R from "remeda";
import { z } from "zod";
import type { Transactor } from "../../db/index.js";
import type { LlmProvider } from "../../llm/provider.js";
import { chatTyped } from "../../llm/typed.js";
import { logger } from "../../logger.js";
import type { AgentStore } from "../store/index.js";

// --- Consolidation schema ---

const MergeGroupSchema = z.object({
  originalIds: z.array(z.string()).min(2).describe("IDs of rules to merge"),
  mergedRule: z.string().describe("The consolidated rule text"),
  category: z
    .enum(["style", "domain", "memory"])
    .describe("Category of the merged rule (must match originals)"),
});

export const ConsolidationSchema = z.object({
  groups: z
    .array(MergeGroupSchema)
    .describe("Groups of rules to merge. Empty if no merges needed."),
});

export type Consolidation = z.infer<typeof ConsolidationSchema>;

// --- Consolidation prompt ---

function buildConsolidationPrompt(
  rules: ReadonlyArray<{ id: string; rule: string; category: string; observationCount: number }>,
): string {
  const rulesList = rules
    .map((r) => `- [${r.id}] (${r.category}, seen ${r.observationCount}x) ${r.rule}`)
    .join("\n");

  return `You are a rule consolidation assistant. You have a list of behavioral rules extracted from conversations with a user. Some rules may be semantically equivalent or overlapping.

## Task

Group rules that say essentially the same thing and produce a single, clear merged version for each group. Rules that are genuinely distinct should NOT be merged.

## Constraints

- Only merge rules within the same category. Never merge across categories.
- The merged rule should capture all the intent of the originals without being overly specific.
- Prefer concise merged rules — combine, don't concatenate.
- If no rules can be merged, return an empty groups array.
- Each rule should appear in at most one group.

## Rules

${rulesList}

Identify groups of semantically equivalent rules and produce merged versions.`;
}

// --- Consolidation logic ---

export interface ConsolidationDeps {
  provider: LlmProvider;
  model: string;
  runInTx: Transactor;
  store: Pick<AgentStore, "getCorrections" | "replaceRules">;
}

export interface ConsolidationResult {
  mergedGroups: number;
  rulesRemoved: number;
}

export async function consolidateRules(
  profileId: string,
  deps: ConsolidationDeps,
): Promise<ConsolidationResult> {
  const allRules = await deps.runInTx((tx) => deps.store.getCorrections(tx, profileId));
  // Group by channel scope so each LLM invocation only sees rules of one
  // scope. `replaceRules` writes the merged row with the same channelType
  // it was called with, so per-scope runs preserve scope without giving
  // the LLM any opportunity to propose a cross-scope merge.
  const activeRules = allRules.filter((r) => r.active);
  const byChannel = R.groupBy(activeRules, (r) => r.channelType ?? "");

  let mergedGroups = 0;
  let rulesRemoved = 0;

  for (const [channelKey, rules] of Object.entries(byChannel)) {
    if (rules.length < 2) {
      continue;
    }
    const channelType = channelKey === "" ? null : channelKey;
    const result = await consolidateChannelGroup(rules, channelType, deps);
    mergedGroups += result.mergedGroups;
    rulesRemoved += result.rulesRemoved;
  }

  logger.info({ mergedGroups, rulesRemoved }, "rule consolidation complete");

  return { mergedGroups, rulesRemoved };
}

async function consolidateChannelGroup(
  rules: ReadonlyArray<{
    id: string;
    rule: string;
    category: string;
    observationCount: number;
  }>,
  channelType: string | null,
  deps: ConsolidationDeps,
): Promise<ConsolidationResult> {
  const systemPrompt = buildConsolidationPrompt(rules);

  const { data } = await chatTyped({
    provider: deps.provider,
    model: deps.model,
    system: systemPrompt,
    messages: [{ role: "user", content: "Consolidate the rules above." }],
    schema: ConsolidationSchema,
    name: "rule-consolidation",
    repair: {},
  });

  let mergedGroups = 0;
  let rulesRemoved = 0;
  const consumedIds = new Set<string>();

  for (const group of data.groups) {
    const originals = rules.filter((r) => group.originalIds.includes(r.id));

    // Validate: all IDs exist, no overlaps, category matches
    if (
      originals.length !== group.originalIds.length ||
      originals.some((r) => r.category !== group.category) ||
      group.originalIds.some((id) => consumedIds.has(id))
    ) {
      logger.warn({ group, channelType }, "invalid merge group from LLM — skipped");
      continue;
    }
    for (const id of group.originalIds) {
      consumedIds.add(id);
    }

    const totalObservations = originals.reduce((sum, r) => sum + r.observationCount, 0);

    await deps.runInTx((tx) =>
      deps.store.replaceRules(tx, {
        oldIds: group.originalIds,
        newRule: {
          rule: group.mergedRule,
          category: group.category,
          profileId: null,
          channelType,
          priority: 100,
          observationCount: totalObservations,
        },
      }),
    );

    mergedGroups++;
    rulesRemoved += group.originalIds.length - 1; // each group replaces N rules with 1
  }

  return { mergedGroups, rulesRemoved };
}
