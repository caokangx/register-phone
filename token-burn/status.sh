#!/usr/bin/env bash
# Unified status: campaign window + active project task progress.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/env.sh" ]] && source "$SCRIPT_DIR/env.sh"
PRETTY_JSON=(python3 "$SCRIPT_DIR/pretty-json.py")

is_running() {
  local dir="$1"
  [[ -f "$dir/run.pid" ]] && kill -0 "$(cat "$dir/run.pid")" 2>/dev/null
}

echo "========== 3-day Campaign =========="
if [[ -f "$SCRIPT_DIR/campaign.json" ]]; then
  "${PRETTY_JSON[@]}" "$SCRIPT_DIR/campaign.json"
else
  echo "(no campaign.json — run bootstrap.sh or run-daily-campaign.sh --reset)"
fi

echo ""
echo "========== Last Random Pick =========="
if [[ -f "$SCRIPT_DIR/last-random.json" ]]; then
  "${PRETTY_JSON[@]}" "$SCRIPT_DIR/last-random.json"
else
  echo "(none)"
fi

echo ""
echo "========== Running Projects =========="
found=false
for dir in "$SCRIPT_DIR"/*/; do
  [[ -f "$dir/run.sh" ]] || continue
  name=$(basename "$dir")
  if is_running "$dir"; then
    found=true
    echo ""
    echo "--- $name (PID $(cat "$dir/run.pid")) ---"
    "$dir/run.sh" --status 2>/dev/null || true
  fi
done
if ! $found; then
  echo "(no project running in background)"
  echo ""
  echo "Projects with run.pid but dead process:"
  for dir in "$SCRIPT_DIR"/*/; do
    [[ -f "$dir/run.pid" ]] || continue
    name=$(basename "$dir")
    if ! is_running "$dir"; then
      echo "  $name — stale PID $(cat "$dir/run.pid")"
    fi
  done
fi

echo ""
echo "========== Token Usage =========="
if [[ -f "$SCRIPT_DIR/aggregate-usage.py" ]]; then
  python3 "$SCRIPT_DIR/aggregate-usage.py" "$SCRIPT_DIR" || echo "(failed to parse usage logs)"
else
  echo "(aggregate-usage.py not found)"
fi

echo ""
echo "========== Quick Logs =========="
echo "  tail -f $SCRIPT_DIR/logs/campaign.log"
for dir in "$SCRIPT_DIR"/*/; do
  [[ -f "$dir/logs/main.log" ]] || continue
  name=$(basename "$dir")
  echo "  tail -f $SCRIPT_DIR/$name/logs/main.log"
done
