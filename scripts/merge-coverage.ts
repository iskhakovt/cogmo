/**
 * Merges Vitest unit + integration coverage into one report.
 *
 * Reads `coverage/unit/coverage-final.json` and
 * `coverage/integration/coverage-final.json`, sums per-file hit counters
 * via istanbul-lib-coverage, and emits:
 *   - coverage/merged/coverage-final.json
 *   - coverage/merged/coverage-summary.json
 *   - coverage/merged/lcov.info + lcov-report/
 *   - coverage/merged/text-summary on stdout
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const root = resolve(import.meta.dirname, "..");
const unit = JSON.parse(readFileSync(resolve(root, "coverage/unit/coverage-final.json"), "utf8"));
const integ = JSON.parse(
  readFileSync(resolve(root, "coverage/integration/coverage-final.json"), "utf8"),
);

const map = libCoverage.createCoverageMap({});
map.merge(unit);
map.merge(integ);

const context = libReport.createContext({
  dir: resolve(root, "coverage/merged"),
  coverageMap: map,
  defaultSummarizer: "nested",
});

for (const r of ["json", "json-summary", "lcov", "text-summary"] as const) {
  reports.create(r as never).execute(context);
}
