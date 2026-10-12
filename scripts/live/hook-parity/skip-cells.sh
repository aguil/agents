#!/bin/sh
# ADR 0028 decision 4 on a live cursor-agent: a gated hook that skips leaves
# the call unchanged on every Cursor event decision 5 gates.
#
#   skip-cells.sh <out-dir> <agents CLI> <bin dir holding the gate timer> [kind...]
#
# One harness run of hp-skip writes .cursor/hooks.json: an unscoped
# pre_tool_call and post_tool_call handler whose matcher names no tool, so
# its gate registers on all six gated events and skips every call. Then each
# call kind (shell, an in-place edit, MCP) runs through `agent` twice with
# the same argv: once with no hooks file (control) and once with that file.
# Each cell keeps the stream, the gate log, the handler log (which must stay
# empty), the MCP server's log and Cursor's own debug log, which records
# every hook it ran as cli.hook.executed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$1
agents=$2
bin=$3
shift 3
kinds=${*:-shell edit mcp}
mkdir -p "$out"

gen=$out/generate
mkdir -p "$gen/workspace"
(
  cd "$gen/workspace"
  env HP_LOG="$gen/hook-calls.jsonl" HP_GATE_LOG="$gen/gates.log" \
    HP_AGENTS="$agents" PATH="$bin:$PATH" \
    "$agents" harness run hp-skip --agents-dir "$here/.agents" \
    --workspace "$gen/workspace" --adapter cursor \
    >"$gen/harness-run.stdout" 2>"$gen/harness-run.stderr" || true
)
# Only the file is needed here; the role's own outcome does not matter.
cp "$gen/workspace/.cursor/hooks.json" "$out/hooks.json"

prompt_for() {
  case $1 in
  shell) echo "Run exactly this shell command with your shell tool, once, and nothing else: echo hp-skip-shell. Then reply DONE." ;;
  edit) echo 'The workspace holds seed.txt, whose second line is "status: original". Change that line to "status: changed" in place, using your file-editing tool, not a shell command. Make no other tool call, then reply DONE.' ;;
  mcp) echo "Call the tool echo_token on the MCP server named hpprobe, with no arguments, exactly once. Use no other tool. Then reply with what it returned." ;;
  esac
}

cell() { # <kind> <control|gated>
  dir=$out/$1-$2
  rm -rf "$dir"
  ws=$dir/workspace
  mkdir -p "$ws/.cursor"
  printf 'hook-parity live check\nstatus: original\n' >"$ws/seed.txt"
  if [ "$1" = mcp ]; then
    cat >"$ws/.cursor/mcp.json" <<JSON
{"mcpServers":{"hpprobe":{"command":"python3","args":["-I","$here/mcp_server.py"],"env":{"HP_MCP_LOG":"$dir/mcp-server.jsonl","HP_MCP_TOKEN":"$1-$2"}}}}
JSON
    printf '{"permissions":{"allow":["Mcp(hpprobe:echo_token)"],"deny":[]}}\n' >"$ws/.cursor/cli.json"
  fi
  [ "$2" = gated ] && cp "$out/hooks.json" "$ws/.cursor/hooks.json"
  approve=
  [ "$1" = mcp ] && approve=--approve-mcps
  agent --version >"$dir/agent-version.txt"
  (
    cd "$ws"
    # shellcheck disable=SC2086
    # A TMPDIR per cell gives Cursor's debug log a directory of its own.
    mkdir -p "$dir/tmp"
    env HP_LOG="$dir/hook-calls.jsonl" HP_GATE_LOG="$dir/gates.log" \
      HP_AGENTS="$agents" PATH="$bin:$PATH" TMPDIR="$dir/tmp" \
      timeout 240 agent --print --output-format stream-json --trust \
      --workspace "$ws" --sandbox enabled $approve "$(prompt_for "$1")" \
      </dev/null >"$dir/stream.jsonl" 2>"$dir/stderr.log" || echo "exit $?" >"$dir/exit.txt"
  )
  cat "$dir"/tmp/cursor-agent-logs-*/session-*.log >"$dir/cursor-debug.log" 2>/dev/null || true
  cp "$ws/seed.txt" "$dir/seed-after.txt"
  echo "skip: $1-$2 done"
}

for kind in $kinds; do
  cell "$kind" control
  cell "$kind" gated
done
