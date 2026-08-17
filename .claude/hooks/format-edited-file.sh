#!/usr/bin/env bash
# PostToolUse(Edit|Write) — format the file that was just written.
#
# Biome owns formatting here and CI runs `biome check --error-on-warnings`, so
# an unformatted file is a red build. Formatting on the way out means the
# agent's edits land clean instead of the formatting surfacing a step later as
# a lint failure.
#
# Never blocks. Formatting is a fix-up, not a policy: a file biome cannot fix
# (a real lint error) is left for the Stop gate to report, because interrupting
# mid-edit over a rule the agent is still working through costs more than
# letting it finish. That also means a missing biome is silent here by design —
# the Stop gate is where an inert toolchain gets announced.
set -uo pipefail

# shellcheck source=lib/find-biome.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/find-biome.sh"

payload=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$payload" 2>/dev/null)
[[ -n "$file" && -f "$file" ]] || exit 0

root=$(find_repo_root)
[[ -n "$root" && -d "$root" ]] || exit 0
biome=$(find_biome "$root") || exit 0

# Run from the root: biome discovers biome.json from the working directory, so
# invoked from anywhere else it silently formats to built-in defaults — tabs
# where this repo uses two spaces — and rewrites the file into exactly the red
# build this hook exists to prevent.
cd "$root" || exit 0

# No extension allowlist. `--no-errors-on-unmatched` makes a file biome does
# not handle a no-op costing a few milliseconds, whereas a hand-kept list is a
# second source of truth that goes stale — biome 2.5 lints `.html` and formats
# `.graphql`, and `.mts`/`.cts` are easy to forget.
"$biome" check --write --no-errors-on-unmatched "$file" >/dev/null 2>&1
exit 0
