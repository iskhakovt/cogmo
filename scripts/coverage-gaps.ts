/**
 * Surfaces high-LOC, low-coverage files from the merged coverage report.
 * Prints two views:
 *   - "high risk": files with >100 stmts and <70% line coverage
 *   - "branch gaps": files with >50 branches and <60% branch coverage
 * Use this to triage where to spend test effort.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Pct {
  total: number;
  covered: number;
  pct: number;
}
interface Entry {
  lines: Pct;
  statements: Pct;
  functions: Pct;
  branches: Pct;
}

const root = resolve(import.meta.dirname, "..");
const summary: Record<string, Entry> = JSON.parse(
  readFileSync(resolve(root, "coverage/merged/coverage-summary.json"), "utf8"),
);

const rows = Object.entries(summary)
  .filter(([k]) => k !== "total")
  .map(([file, e]) => ({
    file: file.replace(`${root}/`, ""),
    lines: e.lines.total,
    linesPct: e.lines.pct,
    linesUncov: e.lines.total - e.lines.covered,
    stmts: e.statements.total,
    stmtsPct: e.statements.pct,
    stmtsUncov: e.statements.total - e.statements.covered,
    branches: e.branches.total,
    branchesPct: e.branches.pct,
    branchesUncov: e.branches.total - e.branches.covered,
    funcs: e.functions.total,
    funcsPct: e.functions.pct,
    funcsUncov: e.functions.total - e.functions.covered,
  }));

function fmt(rows: Array<Record<string, string | number>>) {
  const first = rows[0];
  if (!first) return "  (none)";
  const cols = Object.keys(first);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  const fmtRow = (cells: Array<string | number>) =>
    cells.map((c, i) => String(c).padEnd(widths[i] ?? 0)).join("  ");
  return [
    fmtRow(cols),
    fmtRow(cols.map((_c, i) => "-".repeat(widths[i] ?? 0))),
    ...rows.map((r) => fmtRow(cols.map((c) => r[c] ?? ""))),
  ].join("\n");
}

console.log("# High-LOC files with <70% line coverage (sorted by uncovered-line count)\n");
const highRisk = rows
  .filter((r) => r.stmts >= 50 && r.linesPct < 70)
  .sort((a, b) => b.linesUncov - a.linesUncov)
  .map((r) => ({
    file: r.file,
    "stmt%": r.stmtsPct.toFixed(1),
    "line%": r.linesPct.toFixed(1),
    "br%": r.branchesPct.toFixed(1),
    "fn%": r.funcsPct.toFixed(1),
    lines: r.lines,
    "uncov-lines": r.linesUncov,
    "uncov-br": r.branchesUncov,
    "uncov-fn": r.funcsUncov,
  }));
console.log(fmt(highRisk));

console.log("\n# Branch gaps: >=20 branches, <70% covered (sorted by uncovered branch count)\n");
const branchGaps = rows
  .filter((r) => r.branches >= 20 && r.branchesPct < 70)
  .sort((a, b) => b.branchesUncov - a.branchesUncov)
  .map((r) => ({
    file: r.file,
    "br%": r.branchesPct.toFixed(1),
    "line%": r.linesPct.toFixed(1),
    branches: r.branches,
    "uncov-br": r.branchesUncov,
  }));
console.log(fmt(branchGaps));

console.log("\n# Functions never called (>=5 funcs, <50% function coverage)\n");
const funcGaps = rows
  .filter((r) => r.funcs >= 5 && r.funcsPct < 50)
  .sort((a, b) => b.funcsUncov - a.funcsUncov)
  .map((r) => ({
    file: r.file,
    "fn%": r.funcsPct.toFixed(1),
    funcs: r.funcs,
    "uncov-fn": r.funcsUncov,
  }));
console.log(fmt(funcGaps));

console.log("\n# Files with 0% coverage (likely dead or test-only entries)\n");
const zero = rows
  .filter((r) => r.stmts >= 5 && r.stmtsPct === 0)
  .sort((a, b) => b.stmts - a.stmts)
  .map((r) => ({ file: r.file, stmts: r.stmts, funcs: r.funcs }));
console.log(fmt(zero));
