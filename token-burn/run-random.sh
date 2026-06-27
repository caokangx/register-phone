#!/usr/bin/env bash
# Pick a random project and run it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAST_PICK_FILE="$SCRIPT_DIR/last-random.json"

usage() {
  cat <<'EOF'
Usage: ./run-random.sh [options]

Pick one project at random and start its run.sh.

Options:
  --background, -b     Run in background (default)
  --foreground, -f     Run in foreground
  --skip-running       Exclude projects that already have a live background PID
  --dry-run            Print the chosen project without starting it
  --list               List all eligible projects and exit
  -h, --help           Show this help

Examples:
  ./run-random.sh
  ./run-random.sh --skip-running
  ./run-random.sh --dry-run
  ./run-random.sh --foreground
EOF
}

collect_projects() {
  PROJECTS=()
  for dir in "$SCRIPT_DIR"/*/; do
    [[ -f "$dir/run.sh" ]] || continue
    PROJECTS+=("$dir")
  done
}

is_running() {
  local dir="$1"
  local pid_file="$dir/run.pid"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

write_last_pick() {
  local name="$1" mode="$2" action="$3"
  python3 - "$LAST_PICK_FILE" "$name" "$mode" "$action" <<'PY'
import json, sys
from datetime import datetime, timezone
out, name, mode, action = sys.argv[1:5]
data = {
    "project": name,
    "mode": mode,
    "action": action,
    "picked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "dir": str(__import__("pathlib").Path(out).parent / name),
}
open(out, "w").write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
}

MODE="background"
SKIP_RUNNING=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --background|-b) MODE="background"; shift ;;
    --foreground|-f) MODE="foreground"; shift ;;
    --skip-running) SKIP_RUNNING=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --list)
      collect_projects
      if [[ ${#PROJECTS[@]} -eq 0 ]]; then
        echo "No projects found."
        exit 1
      fi
      for dir in "${PROJECTS[@]}"; do
        name=$(basename "$dir")
        if is_running "$dir"; then
          echo "$name (running)"
        else
          echo "$name"
        fi
      done
      exit 0
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

collect_projects
if [[ ${#PROJECTS[@]} -eq 0 ]]; then
  echo "No projects with run.sh found under $SCRIPT_DIR" >&2
  exit 1
fi

POOL=()
for dir in "${PROJECTS[@]}"; do
  if $SKIP_RUNNING && is_running "$dir"; then
    continue
  fi
  POOL+=("$dir")
done

if [[ ${#POOL[@]} -eq 0 ]]; then
  echo "No available projects to run (all may be running). Use --list to check." >&2
  exit 1
fi

idx=$((RANDOM % ${#POOL[@]}))
chosen="${POOL[$idx]}"
name=$(basename "$chosen")

echo "Random pick: $name (${#POOL[@]} eligible / ${#PROJECTS[@]} total)"

if $DRY_RUN; then
  write_last_pick "$name" "$MODE" "dry-run"
  echo "Dry run only. To start: $chosen/run.sh --$MODE"
  exit 0
fi

write_last_pick "$name" "$MODE" "started"

if [[ "$MODE" == "background" ]]; then
  "$chosen/run.sh" --background
else
  "$chosen/run.sh" --foreground
fi
