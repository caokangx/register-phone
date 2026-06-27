#!/usr/bin/env bash
# Run all projects sequentially or in parallel
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 [--background] [--parallel N] [--status] [--stop-all]"
  echo "  --background   Start each project runner in background"
  echo "  --parallel N   Start up to N projects concurrently (default 1 = sequential)"
  echo "  --status       Show progress for all projects"
  echo "  --stop-all     Stop all background runners"
}

show_all_status() {
  for dir in "$SCRIPT_DIR"/*/; do
  [[ -f "$dir/run.sh" ]] || continue
  name=$(basename "$dir")
  echo "===== $name ====="
  "$dir/run.sh" --status 2>/dev/null || echo "(not started)"
  echo ""
  done
}

stop_all() {
  for dir in "$SCRIPT_DIR"/*/; do
  [[ -f "$dir/run.sh" ]] || continue
  "$dir/run.sh" --stop 2>/dev/null || true
  done
  echo "All stop signals sent."
}

run_projects() {
  local mode="${1:-foreground}"
  local parallel="${2:-1}"
  local projects=()
  for dir in "$SCRIPT_DIR"/*/; do
    [[ -f "$dir/run.sh" ]] || continue
    projects+=("$dir")
  done

  if [[ "$parallel" -le 1 ]]; then
    for dir in "${projects[@]}"; do
      echo ">>> Starting $(basename "$dir")"
      if [[ "$mode" == "background" ]]; then
        "$dir/run.sh" --background
      else
        "$dir/run.sh" --foreground
      fi
    done
  else
    local running=0
    for dir in "${projects[@]}"; do
      echo ">>> Launching $(basename "$dir")"
      "$dir/run.sh" --background
      running=$((running + 1))
      if [[ $running -ge $parallel ]]; then
        wait -n 2>/dev/null || sleep 30
        running=$((running - 1))
      fi
    done
    wait || true
  fi
}

case "${1:-}" in
  --background|-b)
    run_projects background "${2:-1}"
    ;;
  --parallel|-p)
    run_projects background "${2:-3}"
    ;;
  --status|-s)
    show_all_status
    ;;
  --stop-all)
    stop_all
    ;;
  --help|-h)
    usage
    ;;
  "")
    run_projects foreground 1
    ;;
  *)
    usage
    exit 1
    ;;
esac
