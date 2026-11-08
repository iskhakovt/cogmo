Two scoped pnpm overrides take glob 10 and its minimatch 9 out of the tree, clearing Dependabot alerts #186 (glob, GHSA-3g3m-2fjr-6pw4) and #188 (minimatch, GHSA-g3hv-75wg-m249), both moderate.

- **Runtime.** `gcp-metadata` (inngest → OpenTelemetry's GCP resource detector) pins gaxios 7.1.3, which declares an unused `rimraf` 5 and with it glob 10. `gcp-metadata>gaxios@7.1.3` resolves to 7.1.4, the same build without that dependency.
- **Dev.** `archiver-utils` (testcontainers → archiver) moves from glob 10 to 14.0.3, the first release patched against both advisories, since glob 14 bundles its own minimatch. Only its `file` helpers call glob (`glob.sync`, which glob 14's CommonJS build exports), and archiver calls none of them.
