import { match } from "ts-pattern";
import type { Transactor } from "../../../db/index.js";
import type { SkillsDeployOutcomeData } from "../../../inngest/events.js";
import { logger } from "../../../logger.js";
import type { SkillRiskReason } from "../../../skills/risk-reasons.js";
import {
  buildSkillsApprovalKeyboard,
  buildSkillsLiveKeyboard,
  type SkillsInlineKeyboardMarkup,
} from "../../../skills/skills-keyboard.js";
import type { TransportStore } from "../../store/index.js";

type DeployedOutcome = Extract<SkillsDeployOutcomeData, { outcome: "live" | "pending_approval" }>;

/** Each risk reason as the deploy message names it (design/skills.md → Risk tiers without a human → Reasons). */
const REASON_LABELS: Readonly<Record<SkillRiskReason, string>> = {
  binding_unenforced: "a bound secret this deployment cannot substitute yet",
  egress_network_missing: "tier-2 network access without the egress proxy",
  egress_listener_missing: "network access without the egress listener",
  opted_in: "matches a class you opted in to approving",
  first_deploy: "a first deploy",
  manifest_widened: "widens the live version's manifest",
  tier1_unhardened: "tier 1 runs without its hardened boundary",
  tier2_unenforced: "tier 2 egress is not enforced",
  tier2_shared_worker: "tier 2 shares a worker between tasks",
  acting_effect: "an acting effect (write, send, delete, financial or subprocess)",
  unlisted_dependency: "a dependency on neither list",
  sensitive_dependency: "a dependency on the approve list",
  paid_call: "a paid call",
  raw_secret: "a secret without a binding",
  reads_and_egress: "reads data and reaches the network",
  no_review_panel: "no review panel stands in for you",
  container_tier: "the container tier",
  approve_gating_effect: "an effect that needs approval",
  secrets_with_network: "a secret together with network access",
  secret_breadth: "three or more secrets",
  declared_effect: "declares effects",
  network_declared: "reaches the network",
};

/**
 * The message for a deploy outcome (design/skills.md → Notifications and
 * undo). Plain text on purpose: skill names, descriptions and errors are
 * manifest-author-controlled, and a Markdown parse failure would 400 the
 * whole send. A section with nothing to say is left out.
 */
function deployOutcomeText(event: SkillsDeployOutcomeData): string {
  return match(event)
    .with({ outcome: "live" }, (live) => {
      const headline =
        live.priorGitSha !== null && live.priorGitSha !== live.gitSha
          ? `✅ Skill ${live.skillName} updated ${shortSha(live.priorGitSha)} → ${shortSha(live.gitSha)}`
          : `✅ Skill ${live.skillName} is live`;
      return [headline, live.description, "", ...factLines(live, "whoever registered it")].join(
        "\n",
      );
    })
    .with({ outcome: "pending_approval" }, (pending) => {
      const commit =
        pending.priorGitSha !== null && pending.priorGitSha !== pending.gitSha
          ? `Commit: ${shortSha(pending.gitSha)}, replacing ${shortSha(pending.priorGitSha)}`
          : `Commit: ${shortSha(pending.gitSha)}`;
      return [
        `🛡️ Skill deploy awaiting approval: ${pending.skillName}`,
        pending.description,
        "",
        ...factLines(pending, "whoever approves it"),
        commit,
        "",
        "Approve puts it live. Deny resolves this deploy as denied; a changed version needs a new register.",
      ].join("\n");
    })
    .with({ outcome: "rejected" }, (rejected) => {
      const subject = rejected.skillName || shortSha(rejected.gitSha) || "unknown branch";
      return [`❌ Skill register rejected: ${subject}`, ...rejected.errors].join("\n");
    })
    .exhaustive();
}

/** The reasons, effects, hosts, secrets, dependencies and schedule, one line each when present. */
function factLines(event: DeployedOutcome, runsAs: string): string[] {
  const { declared, detected } = event.effects;
  const effects =
    declared.length === 0 && detected.length === 0
      ? "Effects: none"
      : `Effects: declared ${listOrNone(declared)}; detected ${listOrNone(detected)}`;
  return [
    ...(event.reasons.length > 0
      ? [`Why ${event.riskTier}: ${event.reasons.map((r) => REASON_LABELS[r]).join("; ")}`]
      : []),
    effects,
    ...(event.hosts.length > 0 ? [`Hosts: ${event.hosts.join(", ")}`] : []),
    ...(event.secrets.length > 0
      ? [
          `Secrets: ${event.secrets.map((s) => `${s.name} (${s.bound ? "bound" : "raw"})`).join(", ")}`,
        ]
      : []),
    ...(event.dependencies.length > 0 ? [`Dependencies: ${event.dependencies.join(", ")}`] : []),
    ...(event.schedule !== null ? [`Schedule: ${event.schedule} — runs as ${runsAs}`] : []),
  ];
}

function listOrNone(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function deployOutcomeKeyboard(
  event: SkillsDeployOutcomeData,
): SkillsInlineKeyboardMarkup | undefined {
  return match(event)
    .with({ outcome: "live" }, (live) => buildSkillsLiveKeyboard(live.skillId))
    .with({ outcome: "pending_approval" }, (pending) =>
      buildSkillsApprovalKeyboard(pending.deployId),
    )
    .with({ outcome: "rejected" }, () => undefined)
    .exhaustive();
}

export type SkillsDeployOutcomeSendMessage = (
  chatId: number,
  text: string,
  opts: { reply_markup?: SkillsInlineKeyboardMarkup },
) => Promise<unknown>;

export type PostSkillsDeployOutcomeResult =
  | { posted: true }
  | { posted: false; reason: "no_telegram_session" | "send_failed" };

/**
 * Per-channel handler for `skills/deploy/outcome`: posts the outcome into
 * this channel's session on the event's conversation, with Disable on a
 * live deploy and Approve / Deny on a pending one. Extracted from the
 * Telegram adapter setup so the glue (session lookup → message → send
 * guard) is unit-testable without an Inngest runtime.
 *
 * Returns a discriminated result so the caller (the Inngest function body)
 * can surface the outcome on the function return for observability.
 */
export async function postSkillsDeployOutcome(args: {
  event: SkillsDeployOutcomeData;
  channelId: string;
  runInTx: Transactor;
  transportStore: TransportStore;
  sendMessage: SkillsDeployOutcomeSendMessage;
}): Promise<PostSkillsDeployOutcomeResult> {
  const { event, channelId, runInTx, transportStore, sendMessage } = args;

  const sessions = await runInTx((tx) =>
    transportStore.getActiveSessionsForConversation(tx, event.conversationId),
  );
  const tgSession = sessions.find((s) => s.channelId === channelId);
  if (!tgSession) {
    return { posted: false, reason: "no_telegram_session" };
  }

  const keyboard = deployOutcomeKeyboard(event);
  // Guard the send: a closed chat / blocked bot / network blip shouldn't
  // take the function down silently. retries=0 on the Inngest function
  // means there's no automatic retry; `/skills` lists every deploy, and a
  // pending one is approved from the CLI (`cogmo skills approve <id>`).
  try {
    await sendMessage(
      Number(tgSession.platformAddress),
      deployOutcomeText(event),
      keyboard ? { reply_markup: keyboard } : {},
    );
    return { posted: true };
  } catch (err) {
    logger.warn(
      {
        err,
        outcome: event.outcome,
        skillName: event.skillName,
        conversationId: event.conversationId,
      },
      "telegram: failed to post skill deploy outcome; /skills lists the deploy",
    );
    return { posted: false, reason: "send_failed" };
  }
}
