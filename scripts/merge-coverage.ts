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
// These ship transitively via @vitest/coverage-v8 — import via deep paths so
// we don't have to add them to package.json just for the merge script.
import libCoverage from "../node_modules/.pnpm/istanbul-lib-coverage@3.2.2/node_modules/istanbul-lib-coverage/index.js";
import libReport from "../node_modules/.pnpm/istanbul-lib-report@3.0.1/node_modules/istanbul-lib-report/index.js";
import reports from "../node_modules/.pnpm/istanbul-reports@3.2.0/node_modules/istanbul-reports/index.js";

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
