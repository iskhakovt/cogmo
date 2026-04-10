/**
 * Commitlint config — single source of truth for valid commit types is
 * `.releaserc.json`. We extend the standard conventional preset for
 * defaults, then derive `type-enum` from the release config so that
 * adding a custom type to `.releaserc.json` automatically updates the
 * PR-title validator. No drift possible by construction.
 *
 * If `.releaserc.json` doesn't define custom `releaseRules` or
 * `presetConfig.types` (the current state — minimal config), the
 * derived list is empty and we fall back to `@commitlint/config-conventional`'s
 * built-in `type-enum`. The override only kicks in once you actually
 * have custom types to enforce.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const releasercPath = fileURLToPath(new URL("./.releaserc.json", import.meta.url));
const releaserc = JSON.parse(readFileSync(releasercPath, "utf8"));

const findPlugin = (name) => releaserc.plugins?.find((p) => Array.isArray(p) && p[0] === name)?.[1];

const analyzer = findPlugin("@semantic-release/commit-analyzer");
const generator = findPlugin("@semantic-release/release-notes-generator");

const types = Array.from(
  new Set([
    ...(analyzer?.releaseRules ?? []).map((r) => r.type).filter(Boolean),
    ...(generator?.presetConfig?.types ?? []).map((t) => t.type),
  ]),
);

export default {
  extends: ["@commitlint/config-conventional"],
  // Only override `type-enum` when `.releaserc.json` declares its own
  // type list. Otherwise, inherit the conventional defaults.
  ...(types.length > 0 && {
    rules: { "type-enum": [2, "always", types] },
  }),
};
