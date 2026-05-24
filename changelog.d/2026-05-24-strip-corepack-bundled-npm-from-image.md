Cleans up the Docker image so trivy stops flagging vulnerabilities in
package managers we don't ship at runtime.

The base stage no longer runs `corepack enable`. Corepack ships with a
hardcoded "Last Known Good" pnpm version that — once any shim is
invoked — gets materialised in `~/.cache/node/corepack/v1/pnpm/<lkg>/`
alongside a bundled `node_modules` tree (vulnerable `tar`, `picomatch`,
`minimatch`, `brace-expansion`, `ip-address`). The LKG drifts behind
upstream by months and was the source of 14 of the 29 trivy alerts on
the published image. Removing the `corepack enable` line in the base
stage avoids seeding the cache and stops the runtime stage from
inheriting it.

The build stage now installs pnpm directly via `npm install -g
pnpm@<version>`, parsing the version out of the `packageManager` field
in `package.json` so the existing pin remains the single source of
truth. The bundled npm in `node:24-slim` is used once during the build
stage and stripped from the runtime stage along with the other shims
we don't need at runtime (`corepack`, `yarn`, `yarnpkg`) and their
backing `/usr/local/lib/node_modules/` directories — pulling another
14 trivy alerts off the published image.

The remaining `qs@<6.15.2` (CVE-2026-8723, DoS in `qs.stringify` with
specific options pulled in transitively via `express → body-parser`)
is pinned through `pnpm-workspace.yaml`'s `overrides` block, matching
the existing `ip-address` and `@opentelemetry/otlp-transformer`
overrides.

Net effect: 29 image-scan findings on the published image collapse to
the 8 upstream debian:12 base-OS findings that have no fix available
(libuuid1, ncurses, util-linux, tar, zlib1g — all `will_not_fix` or
`affected` with no fixed version). Those only go away when the base
image moves off Debian 12.
