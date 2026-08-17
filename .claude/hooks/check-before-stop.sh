#!/usr/bin/env bash
# Stop — refuse to end a turn on a lint error biome can see.
#
# The per-edit hook covers files written through Edit/Write, but plenty of
# changes arrive another way: a script that rewrites package.json, a generated
# migration, a sub-agent's edits. A whole-repo pass costs ~1.5s and catches
# those before the turn ends rather than one CI cycle later.
#
# Typecheck is deliberately absent. It measures 30–37s on this repo even warm,
# and filtering to one package is no cheaper because the server is the bulk of
# it — too much to charge every turn end. `pnpm typecheck` belongs in the
# pre-PR gate list; see .claude/skills/dependency-sweep.
set -uo pipefail

# shellcheck source=lib/find-biome.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/find-biome.sh"

payload=$(cat)
root=$(find_repo_root "$(jq -r '.cwd // empty' <<<"$payload" 2>/dev/null)")
cd "$root" || exit 0

# Report a given failure once, never twice running. Exit 2 on Stop resumes the
# conversation instead of ending it, and this event carries no
# `stop_hook_active` flag, so nothing upstream breaks a cycle: blocking
# unconditionally would trap a turn the agent meant to end red (pausing for a
# question, handing back partial work). The key is the failure text itself, so
# an unchanged complaint lets the second attempt through while a *different*
# complaint still reports — which a working-tree hash cannot do, since
# `git diff HEAD` is blind to untracked files and would mistake a half-fixed
# new file for the state it already reported.
state_file="$root/.git/cogmo-stop-gate"

report() {
  local state
  # Normalise durations out before hashing: biome signs off with
  # "Checked 682 files in 1509ms", so the raw text differs on every run and a
  # hash of it would match nothing, defeating the guard entirely.
  state=$(printf '%s' "$1" |
    sed -E 's/[0-9]+([.,][0-9]+)?[[:space:]]*(ms|µs|us|s)\b/DURATION/g' |
    sha256sum | cut -d' ' -f1)
  if [[ -f "$state_file" && "$(cat "$state_file" 2>/dev/null)" == "$state" ]]; then
    exit 0
  fi
  printf '%s' "$state" > "$state_file" 2>/dev/null
  printf '%s\n' "$1" >&2
  exit 2
}

# An unresolvable biome makes this gate inert. The per-edit hook stays quiet
# about that; here it is worth one report, because silence would read as "the
# tree is clean" for the rest of the session.
if ! biome=$(find_biome "$root"); then
  report "The lint gate could not find a runnable biome (checked the native CLI for @biomejs/biome's resolved version, then node_modules/.bin/biome with node on PATH). Formatting is not being enforced — run pnpm install, or check that node is on PATH."
fi

# `--error-on-warnings` mirrors the `lint` script, so this gate and CI agree on
# what counts as red. Without it a warning-only finding passes here and fails
# there, which is the exact gap the gate exists to close.
if output=$("$biome" check --error-on-warnings . 2>&1); then
  # Clear the marker so the next genuine failure reports even if the tree
  # happens to hash the same as an earlier reported one.
  rm -f "$state_file" 2>/dev/null
  exit 0
fi

report "biome check failed — this turn would end on a red lint. Fix these, or say why they stand:

$output"
