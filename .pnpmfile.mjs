// Resolution hooks. pnpm reads this from the lockfile's directory — the
// workspace root — on every install.

/**
 * Drop the optional `typescript` peer that `inngest`, `@inngest/ai` and
 * `@t3-oss/env-core` declare.
 *
 * `autoInstallPeers` materialises optional peers despite
 * `peerDependenciesMeta.optional` (pnpm/pnpm#11155), and `pnpm deploy --prod`
 * then follows the edge, so the runtime image carries ~54 MB of compiler:
 * `typescript` 5.9.3 and 7.0.2 plus `@typescript/typescript-linux-x64`, the
 * Go-built `tsc` whose stdlib CVEs are the bulk of the image's Trivy findings.
 *
 * Declaring the peer optional is the package asserting it runs without it, and
 * nothing in the production tree imports `typescript` outside type positions —
 * these three want it for inference on their own `.d.ts`, which is a
 * build-time concern the workspace's own devDependency already covers.
 *
 * Keyed on the peer rather than a list of dependents so a new package
 * declaring the same optional peer is covered without editing this file.
 */
function readPackage(pkg, context) {
  if (pkg.peerDependenciesMeta?.typescript?.optional && pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
    delete pkg.peerDependenciesMeta.typescript;
    context.log(`dropped optional typescript peer from ${pkg.name}`);
  }
  return pkg;
}

export const hooks = { readPackage };
