/**
 * What this deployment enforces, as the classifier reads it (design/skills.md
 * → Risk tiers without a human). Flags, never an inspection of the build, so
 * the tier follows what is enforced while the pieces ship in order.
 */
export interface SkillsCapabilities {
  /**
   * The tier-1 boundary is built (design/skills.md → Tier-1 boundary): Pyodide
   * runs in a forked child with no host grants. Until then an unhardened
   * tier-1 skill holds the server's environment, and `auto` is capped at
   * `notify`.
   */
  tier1Hardened: boolean;
  /**
   * A review panel stands in for the owner's tap (the `skills.review_panel`
   * row of `deployment_flags`). Without one, `auto` is capped at `notify`.
   */
  reviewPanel: boolean;
}

/**
 * The capabilities of this build. `reviewPanel` becomes a `deployment_flags`
 * read once the review stage ships.
 */
export const BUILD_CAPABILITIES: Readonly<SkillsCapabilities> = Object.freeze({
  tier1Hardened: false,
  reviewPanel: false,
});
