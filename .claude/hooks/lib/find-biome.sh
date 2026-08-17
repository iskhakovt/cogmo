#!/usr/bin/env bash
# Locate a runnable biome for the hooks. Sourced, not executed.
#
# `node_modules/.bin/biome` is a shell wrapper whose last act is `exec node`,
# so it dies with 127 wherever node is absent from PATH — and a hook that
# treats 127 as "nothing to do" stops formatting without ever saying so.
# Biome also ships a real native executable per platform, which needs no node
# and runs an order of magnitude faster (9ms vs ~200ms), so prefer that and
# keep the wrapper as the fallback for layouts this cannot predict (musl,
# non-pnpm installs).
#
# The version matters: more than one @biomejs/biome can be present in a
# workspace, and only the one `node_modules/@biomejs/biome` resolves to is the
# version the repo lints with. Picking the newest on disk would silently format
# to a different biome's rules than CI enforces.

find_biome() {
  local root="$1"
  local manifest="$root/node_modules/@biomejs/biome/package.json"

  if [[ -f "$manifest" ]] && command -v jq >/dev/null 2>&1; then
    local version os arch
    version=$(jq -r '.version // empty' "$manifest" 2>/dev/null)
    case "$(uname -s)" in
      Linux) os=linux ;;
      Darwin) os=darwin ;;
      *) os="" ;;
    esac
    case "$(uname -m)" in
      x86_64 | amd64) arch=x64 ;;
      aarch64 | arm64) arch=arm64 ;;
      *) arch="" ;;
    esac

    if [[ -n "$version" && -n "$os" && -n "$arch" ]]; then
      local slug="cli-$os-$arch"
      local candidate
      for candidate in \
        "$root/node_modules/.pnpm/@biomejs+$slug@$version/node_modules/@biomejs/$slug/biome" \
        "$root/node_modules/@biomejs/$slug/biome"; do
        if [[ -x "$candidate" ]]; then
          printf '%s' "$candidate"
          return 0
        fi
      done
    fi
  fi

  if [[ -x "$root/node_modules/.bin/biome" ]] && command -v node >/dev/null 2>&1; then
    printf '%s' "$root/node_modules/.bin/biome"
    return 0
  fi

  return 1
}

# Resolve the repo root from the hook payload's `cwd`, falling back to this
# script's own location so the hooks work from any working directory.
find_repo_root() {
  local from_payload="$1"
  if [[ -n "$from_payload" && -d "$from_payload/node_modules" ]]; then
    printf '%s' "$from_payload"
    return 0
  fi
  (cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
}
