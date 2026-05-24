Cleans up the Docker image so trivy stops flagging vulnerabilities in
package managers we don't ship at runtime.

The published image now contains only `node` in `/usr/local/bin/`:
the `corepack`, `npm`, `npx`, `yarn`, `yarnpkg` shims, the backing
`/usr/local/lib/node_modules/{npm,corepack}` directories, and the
`/opt/yarn-v*` install root are stripped from the runtime stage.
Before the change, trivy flagged 14 CVEs against bundled `tar`,
`picomatch`, `minimatch`, `brace-expansion`, and `ip-address` inside
`/usr/local/lib/node_modules/npm/node_modules/...` and another 14
inside `~/.cache/node/corepack/v1/pnpm/<lkg>/dist/node_modules/...`
— the corepack "Last Known Good" pnpm cache that materialised once a
shim was invoked without an explicit `packageManager` in scope.

The build stage uses `corepack prepare --activate "$packageManager"`
to download pnpm and verify the `+sha512.<hash>` pin from
`package.json`. Only the explicitly named version ever materialises
in the corepack cache (no LKG default), and the build stage's
filesystem is never copied into the runtime stage.

A `qs >= 6.15.2` pin via `pnpm-workspace.yaml`'s `overrides` covers
CVE-2026-8723 (DoS in `qs.stringify`, transitive via `express →
body-parser`) — the only remaining Node-side alert.

Net effect: 29 image-scan findings on the published image collapse to
the 8 unfixable debian:12 base-OS findings (libuuid1, ncurses,
util-linux, tar, zlib1g — all `will_not_fix` or `affected` with no
fixed version). Those only go away when the base image moves off
Debian 12.
