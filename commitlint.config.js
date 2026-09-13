/**
 * Commitlint config — single source of truth for valid commit types is
 * `release.config.mjs`. We extend the standard conventional preset for
 * defaults, then derive `type-enum` from the release config so that
 * adding a custom type there automatically updates the PR-title validator.
 * No drift possible by construction.
 *
 * If the release config doesn't define custom `releaseRules` or
 * `presetConfig.types` (the current state — minimal config), the
 * derived list is empty and we fall back to `@commitlint/config-conventional`'s
 * built-in `type-enum`. The override only kicks in once you actually
 * have custom types to enforce.
 */
import releaseConfig from "./release.config.mjs";

const findPlugin = (name) =>
  releaseConfig.plugins?.find((p) => Array.isArray(p) && p[0] === name)?.[1];

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
  // Only override `type-enum` when the release config declares its own
  // type list. Otherwise, inherit the conventional defaults.
  ...(types.length > 0 && {
    rules: { "type-enum": [2, "always", types] },
  }),
};
