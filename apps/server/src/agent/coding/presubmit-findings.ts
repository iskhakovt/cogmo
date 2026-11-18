/**
 * A pre-submit refusal's findings as text, one per line, cut at a finding
 * boundary with a count of the rest: the task's `failure_detail` at 8 KiB,
 * and the chat post at the channel's limit (design/coding-delegation.md →
 * Skills-repo pre-submit → Sizes).
 */

/** The last line of a cut: how many findings it left out. */
const MORE_FINDINGS = /^\[(\d+) more findings\]$/;

function moreFindings(count: number): string {
  return `[${count} more findings]`;
}

/**
 * The most leading `lines` that `fits` accepts, then a line counting the
 * rest. A last line counting what an earlier cut left out joins the count, so
 * text cut twice still counts every finding. When not even the count fits,
 * the count is what comes back.
 */
export function fitFindings(lines: readonly string[], fits: (text: string) => boolean): string {
  const counted = lines.at(-1)?.match(MORE_FINDINGS);
  const findings = counted ? lines.slice(0, -1) : lines;
  const hidden = counted ? Number(counted[1]) : 0;
  // Longest first: the first that fits keeps the most findings.
  for (let kept = findings.length; kept >= 0; kept--) {
    const rest = findings.length - kept + hidden;
    const text = [...findings.slice(0, kept), ...(rest > 0 ? [moreFindings(rest)] : [])].join("\n");
    if (fits(text)) return text;
  }
  return moreFindings(findings.length + hidden);
}
