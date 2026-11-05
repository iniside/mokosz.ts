#!/bin/sh
# Runs a hook script from this directory with node, after checking that node actually starts.
# Without a working node it exits 2, which blocks the tool call: the guards fail closed.
# stdin and args pass through. Usage: sh run.sh <script.ts> [args...]
dir=$(dirname "$0")
script=$1
shift
if node -e "" >/dev/null 2>&1; then
    exec node "$dir/$script" "$@"
fi
echo "mokosz hooks: no working node on PATH, $script did not run" >&2
exit 2
