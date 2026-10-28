**`pnpm-workspace.yaml` carries an advisory floor for `body-parser` at 2.4.0** (GHSA-27r3-jxmh-p828, high). It reaches the production tree through `express`, whose `^2.2.1` already admits the patch.

Dependabot's version updates pass the 7-day `cooldown` to pnpm as a non-strict `minimum-release-age`, which moves any lockfile entry younger than that to an older release. A security bump skips the cooldown and can land a patch only days old. The floor stops the next version update from resolving below it.
