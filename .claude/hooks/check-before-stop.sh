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

# The harness breaks the cycle, not this hook. Exit 2 on Stop resumes the
# conversation instead of ending it, so a gate that blocked unconditionally
# would trap a turn deliberately ended red — pausing for a question, handing
# back partial work. Claude Code sets `stop_hook_active` on the payload once a
# Stop hook has already blocked, and its own guidance is to return success
# while it is true; it also caps consecutive blocks
# (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). So report once, then stand aside.
if [[ "$(jq -r '.stop_hook_active // false' <<<"$payload" 2>/dev/null)" == "true" ]]; then
  exit 0
fi

root=$(find_repo_root)
[[ -n "$root" && -d "$root" ]] || exit 0
cd "$root" || exit 0

# An unresolvable biome makes this gate inert, which is worth saying: silence
# would read as "the tree is clean" for the rest of the session.
if ! biome=$(find_biome "$root"); then
  printf '%s\n' "The lint gate could not find a runnable biome under $root (looked for the native CLI beside node_modules/@biomejs/biome, then node_modules/.bin/biome with node on PATH). Formatting is not being enforced — run pnpm install." >&2
  exit 2
fi

# `--error-on-warnings` mirrors the `lint` script, so this gate and CI agree on
# what counts as red. Without it a warning-only finding passes here and fails
# there, which is the exact gap the gate exists to close.
if output=$("$biome" check --error-on-warnings . 2>&1); then
  exit 0
fi

printf 'biome check failed — this turn would end on a red lint. Fix these, or say why they stand:\n\n%s\n' "$output" >&2
exit 2
