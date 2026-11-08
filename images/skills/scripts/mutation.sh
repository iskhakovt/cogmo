#!/usr/bin/env bash
# Mutation testing for the skills runtime: design/testing.md → Mutation Testing.
# MUTATION_JOBS sets how many mutants run at once (default 4).
set -euo pipefail

skills=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$skills/../.."
jobs=${MUTATION_JOBS:-4}
if ! [[ $jobs =~ ^[1-9][0-9]*$ ]]; then
  echo "MUTATION_JOBS must be a positive integer, not '$jobs'." >&2
  exit 2
fi
cores=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)
report=$skills/mutation-report.txt
rm -f "$report"
work=$(mktemp -d)
export work volume='' image=''

# A container the daemon is still creating appears a moment after its client
# stops, so the volume goes only after two empty looks a second apart. A
# second Ctrl-C can't cut this short.
cleanup() {
  set +e
  trap '' INT TERM HUP
  rm -rf "$work"
  if [ -n "$volume" ]; then
    local containers empty=0
    for _ in $(seq 60); do
      containers=$(docker ps --all --quiet --filter "label=cogmo.mutation=$volume")
      if [ -z "$containers" ]; then
        empty=$((empty + 1))
        [ "$empty" -lt 2 ] || break
      else
        empty=0
        xargs docker rm --force <<<"$containers" >/dev/null 2>&1
      fi
      sleep 1
    done
    docker volume rm --force "$volume" >/dev/null 2>&1 || echo "Left volume $volume behind: docker volume rm $volume" >&2
  fi
  if [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1 && ! docker image rm "$image" >/dev/null 2>&1; then
    echo "Left image $image behind: docker image rm $image" >&2
  fi
}
trap cleanup EXIT

# Every phase runs as a background job the script waits on, so a signal stops
# it at once. It stops every process under the script, Docker clients
# included, so no container starts while cleanup runs.
descendants() {
  local child
  for child in $(pgrep -P "$1"); do
    [ "$child" != "${BASHPID:-}" ] || continue
    descendants "$child"
    echo "$child"
  done
}
interrupted() {
  trap - INT TERM HUP
  # shellcheck disable=SC2046
  kill $(descendants $$) 2>/dev/null || true
  exit "$1"
}
trap 'interrupted 130' INT
trap 'interrupted 143' TERM
trap 'interrupted 129' HUP

# A tag and a volume of this run's own, named before they exist so cleanup
# knows them whenever it runs. A volume rather than a bind mount, so the
# mutants belong to the container's user under rootless and rootful Docker
# alike; every container carries its name, so cleanup finds them by it.
image=cogmo-skills-mutation:$(basename "$work")
volume=cogmo-mutation-$(basename "$work")
docker buildx bake --file docker-bake.hcl --load --set "skills-mutation.tags=$image" skills-mutation &
wait $!
docker volume create --label "cogmo.mutation=$volume" "$volume" >/dev/null

sandbox() {
  docker run --rm --init --network none --cap-drop ALL --label "cogmo.mutation=$volume" "$@"
}
export -f sandbox

# mutmut can exit 0 having checked nothing, so the counts decide.
sandbox --memory "${jobs}g" --cpus $((jobs < cores ? jobs : cores)) --pids-limit $((512 * jobs)) \
  --volume "$volume:/app/mutants" "$image" \
  sh -c 'mutmut run --max-children "$1" >&2 && mutmut export-cicd-stats >/dev/null && python -c "$2"' _ "$jobs" \
  'import json; d = json.load(open("mutants/mutmut-cicd-stats.json")); print(d["total"], d["killed"], sum(d[k] for k in ("killed", "survived", "no_tests", "skipped", "suspicious", "timeout", "segfault", "check_was_interrupted_by_user")))' \
  >"$work/counts" &
wait $! || {
  status=$?
  echo "mutmut's run exited $status; 137 is a SIGKILL, most likely the OOM killer under its ${jobs}g limit." >&2
  exit 1
}
read -r total killed checked <"$work/counts"
if [ "$checked" -lt "$total" ]; then
  echo "mutmut checked $checked of $total mutants; its output is above." >&2
  exit 1
fi

# What a re-run's exit code says. 1 is a failed test and 3 pytest's internal
# error, kills as mutmut counts them. 2 is an interrupted run or a failed
# collection, 124 `timeout`'s and 128 up a signal, from the mutant or the OOM
# killer: with the unmutated suite passing these come from the mutant, so they
# count as kills, but are listed. Anything else means the suite didn't run.
classify() {
  case $1 in
    0) echo survived ;;
    1 | 3) echo killed ;;
    2 | 124) echo listed ;;
    *) if [ "$1" -ge 128 ]; then echo listed; else echo failed; fi ;;
  esac
}
export -f classify

# One mutant against the whole suite, with the mutated copy over `/app/src`. A
# listed or failed run keeps its output, as does a failing unmutated one; $2
# tells the unmutated copies apart.
recheck() {
  local status=0 output outcome
  output=$(sandbox --memory 1g --cpus "$recheck_cpus" --pids-limit 512 --env "MUTANT_UNDER_TEST=$1" \
    --volume "$volume:/app/mutants:ro" --mount "type=volume,src=$volume,dst=/app/src,volume-subpath=src,readonly" \
    --workdir /app/mutants "$image" \
    timeout --kill-after 5 120 python -m pytest tests -x -q -p no:cacheprovider 2>&1) || status=$?
  outcome=$(classify "$status")
  if [ "$outcome" = listed ] || [ "$outcome" = failed ] || { [ -z "$1" ] && [ "$status" -ne 0 ]; }; then
    printf '%s\n' "$output" >"$work/${1:-baseline$2}.log"
  fi
  printf '%s %s\n' "$outcome" "$1"
}
export -f recheck
per_job=$((cores / jobs))
export recheck_cpus=$((per_job < 1 ? 1 : per_job > 2 ? 2 : per_job))

# The unmutated suite, as many at once as the mutants run, so a test that
# fails under load fails here rather than reading as a kill.
seq "$jobs" | xargs -P "$jobs" -I{} bash -c 'recheck "" "$1"' _ {} >"$work/baseline" &
wait $!
if [ "$(grep -c '^survived $' "$work/baseline")" -ne "$jobs" ]; then
  echo "The unmutated suite fails where mutants are re-run:" >&2
  cat "$work"/*.log >&2
  exit 1
fi

# Every mutant mutmut didn't kill, timeouts included.
sandbox --memory 1g --cpus 1 --pids-limit 256 --volume "$volume:/app/mutants:ro" "$image" mutmut results \
  | awk -F': ' 'NF == 2 { sub(/^ +/, "", $1); if ($1 !~ / /) print $1 }' \
  | xargs -P "$jobs" -I{} bash -c 'recheck "$1"' _ {} >"$work/results" &
wait $!
rechecked=$(wc -l <"$work/results")
if [ "$rechecked" -ne $((total - killed)) ]; then
  echo "mutmut results listed $rechecked of the $((total - killed)) mutants it didn't kill." >&2
  exit 1
fi

outcome() { awk -v o="$1" '$1 == o { print $2 }' "$work/results" | sort; }
count() { grep -c . <<<"$1" || true; }
log() { cat "$work/$1.log" 2>/dev/null || true; }
survivors=()
while read -r name; do survivors+=("$name"); done < <(outcome survived)
listed=$(outcome listed)
failed=$(outcome failed)

if [ ${#survivors[@]} -gt 0 ]; then
  sandbox --memory 1g --cpus 1 --pids-limit 256 --volume "$volume:/app/mutants:ro" "$image" \
    bash -c 'set -o pipefail; for m in "$@"; do echo "== survived: $m"; mutmut show "$m" | tail -n +2 || { echo "mutmut show failed for $m." >&2; exit 1; }; done' _ "${survivors[@]}" \
    >"$work/survivors" &
  wait $!
else
  echo "No mutant survived." >"$work/survivors"
fi

{
  cat "$work/survivors"
  if [ -n "$listed" ]; then
    printf '\n== interrupted, timed out or killed by a signal, counted as killed; re-run on a quiet machine:\n'
    while read -r name; do
      echo "-- $name"
      log "$name"
    done <<<"$listed"
  fi
  while read -r name; do
    [ -n "$name" ] || continue
    printf '\n== failed to run: %s\n' "$name"
    log "$name"
  done <<<"$failed"
} >"$report"

echo "$total mutants: $((total - ${#survivors[@]} - $(count "$failed"))) killed ($(count "$listed") interrupted, timed out or by a signal), ${#survivors[@]} survived, $(count "$failed") failed to run. Report: $report" >&2
[ -z "$failed" ]
