#!/usr/bin/env bash
# PreToolUse(Bash) for read-only agents (cogmo-reviewer) — allow a command only
# when every segment of it reads.
#
# A subagent's `tools` field takes bare tool names, so `Bash` is all or
# nothing; this hook is the documented way to narrow it. Allowlist, not
# denylist: a segment passes only if its program (and, for git/gh, its
# subcommand) is listed below. Anything else, any output redirection to a
# file, and any command substitution are blocked with exit 2, which feeds the
# reason back to the agent.
set -uo pipefail

block() {
  printf 'Blocked by readonly-bash: %s\n' "$1" >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || block "jq is not on PATH, cannot inspect the command"
cmd=$(jq -r '.tool_input.command // empty')
[[ -n "$cmd" ]] || exit 0

# Single-quoted text is literal to the shell; blank it so a pattern like
# grep 'a|b' or grep '>' is not read as a pipe or a redirection.
unquoted=$(sed -E "s/'[^']*'/Q/g" <<<"$cmd")

# Command substitution can hide any program inside an allowed one.
# shellcheck disable=SC2016 # matching the literal characters, not expanding
[[ "$unquoted" == *'$('* || "$unquoted" == *'`'* ]] && block "command substitution is not allowed"

# Double-quoted text cannot hold a separator or redirection the shell acts on
# once substitution is ruled out.
unquoted=$(sed -E 's/"[^"]*"/Q/g' <<<"$unquoted")

# Redirection to a file writes. Strip the harmless forms first: fd duplication
# (2>&1, >&2) and discarding to /dev/null.
stripped=$(sed -E 's/[0-9]*>&[0-9]+//g; s/[0-9]*>>?[[:space:]]*\/dev\/null//g' <<<"$unquoted")
[[ "$stripped" == *'>'* ]] && block "output redirection to a file is not allowed"

git_ok=' diff log show status rev-parse ls-files ls-tree grep blame merge-base cat-file fetch shortlog describe name-rev rev-list for-each-ref '
gh_ok=' view diff list checks status '
prog_ok=' cat head tail grep rg wc ls find sed awk jq sort uniq cut tr diff comm nl stat file basename dirname realpath pwd echo printf true test xargs '

# Split on pipes and command separators; each segment is checked alone.
while IFS= read -r segment; do
  read -r -a words <<<"$segment"
  [[ ${#words[@]} -eq 0 ]] && continue
  # Skip leading VAR=value assignments and `cd <dir>`.
  i=0
  while [[ $i -lt ${#words[@]} && "${words[$i]}" == *=* && "${words[$i]}" != -* ]]; do i=$((i + 1)); done
  prog=${words[$i]:-}
  [[ -z "$prog" ]] && continue
  rest=("${words[@]:$((i + 1))}")
  case "$prog" in
    cd) continue ;;
    git)
      # Skip global options such as -C <dir> and --no-pager.
      j=0
      while [[ $j -lt ${#rest[@]} && "${rest[$j]}" == -* ]]; do
        [[ "${rest[$j]}" == "-C" || "${rest[$j]}" == "-c" ]] && j=$((j + 1))
        j=$((j + 1))
      done
      sub=${rest[$j]:-}
      [[ "$git_ok" == *" $sub "* ]] || block "git $sub is not a read-only git command"
      [[ " ${rest[*]}" == *" --output"* ]] && block "git --output writes a file"
      ;;
    gh)
      area=${rest[0]:-}
      verb=${rest[1]:-}
      if [[ "$area" == "api" ]]; then
        [[ " ${rest[*]} " =~ [[:space:]](-X|--method|-f|-F|--field|--raw-field|--input)[[:space:]=] ]] &&
          block "gh api is allowed for GET requests only"
      elif [[ "$area" == "pr" || "$area" == "issue" || "$area" == "run" ]]; then
        [[ "$gh_ok" == *" $verb "* ]] || block "gh $area $verb is not read-only"
      else
        block "gh $area is not allowed"
      fi
      ;;
    sed)
      [[ " ${rest[*]} " =~ [[:space:]](-i|--in-place)[^[:space:]]*[[:space:]] ]] && block "sed -i writes files"
      [[ "$cmd" =~ (^|[;[:space:]\'])[0-9,\$]*[wWe][[:space:]] ]] && block "sed w/e commands are not allowed"
      ;;
    find)
      [[ " ${rest[*]} " =~ [[:space:]]-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)[[:space:]] ]] &&
        block "find with an action that runs or writes is not allowed"
      ;;
    awk)
      [[ "$cmd" == *system* || "$cmd" == *'| "'* || "$cmd" == *'>'* ]] &&
        block "awk with system(), pipes or redirection is not allowed"
      ;;
    xargs)
      # xargs runs its argument as a command; require it to be a reader.
      k=0
      while [[ $k -lt ${#rest[@]} && "${rest[$k]}" == -* ]]; do k=$((k + 1)); done
      target=${rest[$k]:-}
      [[ " cat head tail grep rg wc ls stat file " == *" $target "* ]] || block "xargs $target is not allowed"
      ;;
    *)
      [[ "$prog_ok" == *" $prog "* ]] || block "$prog is not on the read-only allowlist"
      ;;
  esac
done < <(sed -E 's/(\|\||&&|;|\||&)/\n/g' <<<"$stripped")

exit 0
