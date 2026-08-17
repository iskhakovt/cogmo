#!/usr/bin/env bash
# Shared helpers for the hooks. Sourced, not executed.

# The tree the session is editing.
#
# Claude Code exports CLAUDE_PROJECT_DIR for hook commands, which is the
# project root it was launched with — a linked worktree when the session runs
# in one. `git rev-parse --show-toplevel` answers the same question when the
# variable is absent (running a hook by hand, or an older CLI).
#
# Neither "walk up looking for node_modules" nor "use the script's own
# location" works: every workspace member has its own node_modules, so the
# first would root at apps/server whenever that is the cwd, and the second
# always names the main checkout, so a worktree session would be told about a
# tree it is not editing.
find_repo_root() {
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -d "$CLAUDE_PROJECT_DIR" ]]; then
    printf '%s' "$CLAUDE_PROJECT_DIR"
    return 0
  fi
  git rev-parse --show-toplevel 2>/dev/null
}

# A runnable biome for `root`.
#
# `node_modules/.bin/biome` is a shell wrapper whose last act is `exec node`,
# so it dies with 127 wherever node is absent from PATH. Biome also ships a
# native executable per platform that needs no node and runs an order of
# magnitude faster, so prefer that.
#
# Follow the symlink pnpm already maintains rather than reconstructing its
# virtual-store path: whatever `node_modules/@biomejs/biome` resolves to is by
# construction the version the repo lints with, so the native binary beside it
# is the right one — and that holds for hoisted and npm layouts, and for a
# custom virtual-store-dir, none of which a hand-built path would survive.
find_biome() {
  local root="$1"
  local pkg
  pkg=$(readlink -f "$root/node_modules/@biomejs/biome" 2>/dev/null)

  if [[ -n "$pkg" && -d "$pkg" ]]; then
    # Exactly one platform package is installed — the optional dependency for
    # the host — so the glob resolves to a single candidate.
    local candidate
    for candidate in "$(dirname "$pkg")"/cli-*/biome; do
      if [[ -x "$candidate" ]]; then
        printf '%s' "$candidate"
        return 0
      fi
    done
  fi

  if [[ -x "$root/node_modules/.bin/biome" ]] && command -v node >/dev/null 2>&1; then
    printf '%s' "$root/node_modules/.bin/biome"
    return 0
  fi

  return 1
}
