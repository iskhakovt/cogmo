/**
 * semantic-release config. `commitlint.config.js` derives the PR-title type
 * list from it, so custom commit types are declared once, here.
 */
export default {
  branches: ["main"],
  plugins: [
    // conventionalcommits, not the plugins' default angular preset: angular's
    // header pattern rejects `feat(scope)!:`, so a `!` breaking change would not
    // release at all.
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    [
      "@semantic-release/release-notes-generator",
      { preset: "conventionalcommits", parserOpts: { referenceActions: [] } },
    ],
    "@semantic-release/github",
  ],
};
