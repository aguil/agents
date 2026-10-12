#!/bin/sh
# Hook-parity live checks (ADR 0028, aguil/agents#235 and #220).
#
#   scripts/live/hook-parity/run.sh <out-dir> <check>...
#
# Checks: scoped-cursor, scoped-claude, edit-log, edit-deny, bridge, skip,
# cost. Each writes its own directory under <out-dir>: the workspace, the
# harness run's stdout and stderr, every user-hook call ($HP_LOG) and, on
# Cursor, every gate the run fired ($HP_GATE_LOG).
#
# AGENTS names the agents CLI under test (default: this checkout's
# dist/agents; build it with `bun run build`). Claude runs use the gate as
# harness run generates it, the running CLI's Bun executable and entry script.
# Cursor runs find `agents` on PATH, as generated, where gate-timer.sh stands
# in front of $AGENTS to log each gate's cost.
#
# The user-level ~/.cursor/hooks.json is moved aside for the run and put
# back on exit, so no other hook shares an event with the gate.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
out=$1
shift
mkdir -p "$out"
out=$(cd "$out" && pwd)
AGENTS=${AGENTS:-$repo/dist/agents}
agents_dir=$here/.agents

user_hooks=$HOME/.cursor/hooks.json
if [ -e "$user_hooks" ]; then
  mv "$user_hooks" "$user_hooks.hp-aside"
  trap 'mv "$user_hooks.hp-aside" "$user_hooks"' EXIT INT TERM
  echo "moved $user_hooks aside for the run" >&2
fi

# A bin directory whose `agents` is the gate timer in front of $AGENTS.
bin=$out/bin
mkdir -p "$bin"
ln -sf "$here/gate-timer.sh" "$bin/agents"

new_workspace() {
  ws=$out/$1/workspace
  mkdir -p "$ws"
  printf 'hook-parity live check\nstatus: original\n' >"$ws/seed.txt"
  printf 'keep me\n' >"$ws/victim.txt"
  echo "$ws"
}

harness_run() { # <check> <adapter> <harness>
  dir=$out/$1
  ws=$(new_workspace "$1")
  (
    cd "$ws"
    env HP_LOG="$dir/hook-calls.jsonl" HP_GATE_LOG="$dir/gates.log" \
      HP_AGENTS="$AGENTS" PATH="$bin:$PATH" \
      "$AGENTS" harness run "$3" --agents-dir "$agents_dir" \
      --workspace "$ws" --adapter "$2" \
      >"$dir/harness-run.stdout" 2>"$dir/harness-run.stderr" || true
  )
  cp "$ws/.cursor/hooks.json" "$dir/cursor-hooks.json" 2>/dev/null || true
  find "$ws/.agents-harness/runs" -name claude-settings.json \
    -exec cp {} "$dir/claude-settings.json" \; 2>/dev/null || true
  echo "$1: $(grep -m1 '^artifacts:' "$dir/harness-run.stdout" || echo 'no artifacts line')"
}

for check in "$@"; do
  case $check in
  scoped-cursor) harness_run "$check" cursor hp-scoped ;;
  scoped-claude) harness_run "$check" claude hp-scoped ;;
  edit-log) harness_run "$check" cursor hp-edit-log ;;
  edit-deny) harness_run "$check" cursor hp-edit-deny ;;
  bridge) harness_run "$check" cursor hp-bridge ;;
  skip) "$here/skip-cells.sh" "$out/skip" "$AGENTS" "$bin" ${HP_SKIP_KINDS:-} ;;
  cost) bun "$here/gate-cost.ts" "$AGENTS" >"$out/cost.json" && cat "$out/cost.json" ;;
  *) echo "unknown check: $check" >&2 && exit 2 ;;
  esac
done
