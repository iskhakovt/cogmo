/**
 * A pre-submit refusal's findings as text, cut at a finding boundary with a
 * count of the rest: the task's `failure_detail` at 8 KiB, and the chat post
 * at the channel's limit (design/coding-delegation.md → Skills-repo
 * pre-submit → Sizes). A finding starts a line, and its own line breaks
 * continue it, indented, so the text splits back into the same findings.
 */

import * as R from "remeda";

const CONTINUATION = "\n  ";

/** A line break that starts a finding: one no continuation indent follows. */
const FINDING_BREAK = /\n(?! {2})/;

/** The last line of a cut: how many findings it left out. */
const MORE_FINDINGS = /^\[(\d+) more findings\]$/;

/** The dry run's per-check tail: `<check>: and <n> more <check> findings`. */
const MORE_OF_CHECK = /^(\S+): and (\d+) more \1 findings$/;

function moreFindings(count: number): string {
  return `[${count} more findings]`;
}

/** How many findings `finding` stands for: a per-check tail counts its own. */
function findingCount(finding: string): number {
  const tail = finding.match(MORE_OF_CHECK);
  return tail ? Number(tail[2]) : 1;
}

function joinFindings(findings: readonly string[]): string {
  return findings.map((finding) => finding.replaceAll("\n", CONTINUATION)).join("\n");
}

/** The findings a {@link fitFindings} text holds, its count line included. */
export function splitFindings(text: string): string[] {
  if (text === "") return [];
  return text.split(FINDING_BREAK).map((finding) => finding.replaceAll(CONTINUATION, "\n"));
}

/**
 * The most leading `findings` that `fits` accepts, then a line counting the
 * rest. A last line counting what an earlier cut left out joins the count, so
 * text cut twice still counts every finding. When not even the count fits,
 * the count is what comes back.
 */
export function fitFindings(findings: readonly string[], fits: (text: string) => boolean): string {
  const counted = findings.at(-1)?.match(MORE_FINDINGS);
  const kept = counted ? findings.slice(0, -1) : findings;
  const hidden = counted ? Number(counted[1]) : 0;
  const rest = (from: number) => R.sumBy(kept.slice(from), findingCount) + hidden;
  // Longest first: the first that fits keeps the most findings.
  for (let n = kept.length; n >= 0; n--) {
    const left = rest(n);
    const text = joinFindings([...kept.slice(0, n), ...(left > 0 ? [moreFindings(left)] : [])]);
    if (fits(text)) return text;
  }
  return moreFindings(rest(0));
}
