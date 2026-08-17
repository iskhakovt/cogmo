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

# Only the languages biome parses; it rejects anything else as unmatched.
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.css) ;;
  *) exit 0 ;;
esac

root=$(find_repo_root "$(jq -r '.cwd // empty' <<<"$payload" 2>/dev/null)")
biome=$(find_biome "$root") || exit 0

"$biome" check --write --no-errors-on-unmatched "$file" >/dev/null 2>&1
exit 0
