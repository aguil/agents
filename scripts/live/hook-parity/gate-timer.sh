#!/bin/sh
# Stand-in for --agents-cli in the hook-parity live checks. Runs the real
# agents CLI with stdin, stdout, stderr and exit passed through, and appends
# "<start ns> <end ns> <exit> <subcommand> <event> <probe|call>" to
# $HP_GATE_LOG, so a run shows each gate it fired and what it cost.
start=$(date +%s%N)
if [ -n "${HP_ENTRY:-}" ]; then
  "$HP_BUN" "$HP_ENTRY" "$@"
else
  "$HP_AGENTS" "$@"
fi
code=$?
end=$(date +%s%N)
event=-
kind=call
prev=
for arg in "$@"; do
  [ "$prev" = -- ] && break
  [ "$prev" = --event ] && event=$arg
  [ "$arg" = --probe ] && kind=probe
  prev=$arg
done
printf '%s %s %s %s %s %s\n' "$start" "$end" "$code" "$1" "$event" "$kind" >>"${HP_GATE_LOG:-/dev/null}"
exit "$code"
