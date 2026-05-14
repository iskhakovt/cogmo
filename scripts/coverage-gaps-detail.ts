/**
 * For a given file (relative to repo root), prints the line ranges and
 * branch sites that are uncovered, plus the source excerpt around each.
 * Helps decide if a gap is meaningful or benign.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = process.argv[2];
if (!target) {
  console.error("usage: tsx scripts/coverage-gaps-detail.ts <relative-file-path>");
  process.exit(1);
}

const lcov = readFileSync(resolve(root, "coverage/merged/lcov.info"), "utf8");
const blocks = lcov.split("end_of_record");
const block = blocks.find((b) => b.includes(`SF:${target}\n`));
if (!block) {
  console.error(`no coverage block for ${target}`);
  process.exit(1);
}

interface LineHit {
  line: number;
  hits: number;
}
interface BranchHit {
  line: number;
  block: number;
  branch: number;
  taken: number | null;
}

const lines: LineHit[] = [];
const branches: BranchHit[] = [];
const funcs: Array<{ name: string; hits: number }> = [];
for (const ln of block.split("\n")) {
  const da = ln.match(/^DA:(\d+),(\d+)/);
  if (da) lines.push({ line: Number(da[1]), hits: Number(da[2]) });
  const brda = ln.match(/^BRDA:(\d+),(\d+),(\d+),(.+)/);
  if (brda)
    branches.push({
      line: Number(brda[1]),
      block: Number(brda[2]),
      branch: Number(brda[3]),
      taken: brda[4] === "-" ? null : Number(brda[4]),
    });
  const fnda = ln.match(/^FNDA:(\d+),(.+)/);
  if (fnda?.[2]) funcs.push({ name: fnda[2], hits: Number(fnda[1]) });
}

const src = readFileSync(resolve(root, target), "utf8").split("\n");

const uncoveredLines = lines.filter((l) => l.hits === 0).map((l) => l.line);
const uncoveredFuncs = funcs.filter((f) => f.hits === 0).map((f) => f.name);

const branchByLine = new Map<number, BranchHit[]>();
for (const b of branches) {
  const existing = branchByLine.get(b.line);
  if (existing) existing.push(b);
  else branchByLine.set(b.line, [b]);
}
const uncoveredBranchLines = [...branchByLine.entries()]
  .filter(([, bs]) => bs.some((b) => b.taken === 0))
  .map(([line, bs]) => ({
    line,
    missing: bs.filter((b) => b.taken === 0).length,
    total: bs.length,
  }));

console.log(`# ${target}`);
console.log(`uncovered functions (${uncoveredFuncs.length}): ${uncoveredFuncs.join(", ")}\n`);

function rangify(nums: number[]): Array<[number, number]> {
  const sorted = [...nums].sort((a, b) => a - b);
  const head = sorted[0];
  if (head === undefined) return [];
  const out: Array<[number, number]> = [];
  let s = head;
  let p = s;
  for (const n of sorted.slice(1)) {
    if (n === p + 1) {
      p = n;
    } else {
      out.push([s, p]);
      s = p = n;
    }
  }
  out.push([s, p]);
  return out;
}

console.log("## uncovered line ranges\n");
for (const [s, e] of rangify(uncoveredLines)) {
  console.log(`L${s}${s === e ? "" : `-${e}`}:`);
  for (let i = s; i <= Math.min(e, s + 4); i++) {
    console.log(`  ${i}: ${src[i - 1] ?? ""}`);
  }
  if (e - s > 4) console.log(`  ... (${e - s - 4} more lines)`);
  console.log();
}

console.log("## uncovered branch sites (line: missing/total)\n");
for (const { line, missing, total } of uncoveredBranchLines) {
  console.log(`L${line}  ${missing}/${total}: ${(src[line - 1] ?? "").trim()}`);
}
