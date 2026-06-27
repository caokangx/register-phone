#!/usr/bin/env bash
# 3-day campaign: once per day, random start between 09:00–15:00, one random repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/env.sh" ]] && source "$SCRIPT_DIR/env.sh"
CAMPAIGN_FILE="${CAMPAIGN_FILE:-$SCRIPT_DIR/campaign.json}"
LOG_DIR="$SCRIPT_DIR/logs"
CAMPAIGN_DAYS="${CAMPAIGN_DAYS:-3}"
WINDOW_SECONDS="${WINDOW_SECONDS:-21600}"  # 6 hours: 09:00–15:00

mkdir -p "$LOG_DIR"

usage() {
  cat <<EOF
Usage: ./run-daily-campaign.sh [options]

Run the 3-day schedule: each day at most one random repo job,
with a random delay of 0–6h after 09:00 (i.e. start between 09:00–15:00).

Options:
  --reset          Clear campaign state and start a new 3-day window today
  --status         Show campaign state
  --dry-run        Show what would happen without sleeping or running
  --immediate      Skip 9-15 random delay and start now (still records run)
  -h, --help       Show this help

Cron (recommended):
  0 9 * * * $SCRIPT_DIR/run-daily-campaign.sh >> $LOG_DIR/campaign.log 2>&1
EOF
}

campaign_read() {
  python3 - "$CAMPAIGN_FILE" "$CAMPAIGN_DAYS" <<'PY'
import json, sys
from datetime import date, timedelta
from pathlib import Path

path, max_days = Path(sys.argv[1]), int(sys.argv[2])
today = date.today()

if path.exists():
    data = json.loads(path.read_text())
    start = date.fromisoformat(data["start_date"])
else:
    start = today
    data = {
        "start_date": start.isoformat(),
        "end_date": (start + timedelta(days=max_days - 1)).isoformat(),
        "max_days": max_days,
        "runs": [],
    }
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

end = date.fromisoformat(data.get("end_date", (start + timedelta(days=max_days - 1)).isoformat()))
active = start <= today <= end
day_number = (today - start).days + 1 if today >= start else 0

out = {
    **data,
    "today": today.isoformat(),
    "active": active,
    "day_number": day_number,
    "days_remaining": max(0, (end - today).days + 1) if active else 0,
}
print(json.dumps(out, ensure_ascii=False))
PY
}

campaign_reset() {
  rm -f "$CAMPAIGN_FILE"
  campaign_read > /dev/null
  echo "Campaign reset. New 3-day window starts today."
  python3 "$SCRIPT_DIR/pretty-json.py" "$CAMPAIGN_FILE"
}

campaign_record_run() {
  local project="$1"
  python3 - "$CAMPAIGN_FILE" "$project" <<'PY'
import json, sys
from datetime import datetime, timezone
from pathlib import Path

path, project = Path(sys.argv[1]), sys.argv[2]
data = json.loads(path.read_text())
data.setdefault("runs", []).append({
    "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "local_date": datetime.now().strftime("%Y-%m-%d"),
    "project": project,
})
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
}

RESET=false
DRY_RUN=false
SHOW_STATUS=false
IMMEDIATE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --status) SHOW_STATUS=true; shift ;;
    --immediate) IMMEDIATE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if $RESET; then
  campaign_reset
  exit 0
fi

STATE=$(campaign_read)

if $SHOW_STATUS; then
  python3 "$SCRIPT_DIR/pretty-json.py" "$CAMPAIGN_FILE" 2>/dev/null || echo "No campaign.json yet."
  exit 0
fi

ACTIVE=$(echo "$STATE" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin)['active'] else 'no')")
START=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['start_date'])")
END=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['end_date'])")
DAY=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['day_number'])")

if [[ "$ACTIVE" != "yes" ]]; then
  echo "[$(date)] Campaign inactive (window: $START → $END). Skip."
  exit 0
fi

DELAY=$((RANDOM % (WINDOW_SECONDS + 1)))
DELAY_H=$((DELAY / 3600))
DELAY_M=$(((DELAY % 3600) / 60))

if [[ "$IMMEDIATE" == "true" ]]; then
  echo "[$(date)] Campaign day $DAY/3 | immediate start (no delay)"
else
  echo "[$(date)] Campaign day $DAY/3 | random delay ${DELAY_H}h ${DELAY_M}m → run between 09:00–15:00"
fi

if $DRY_RUN; then
  echo "$STATE" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=2))"
  "$SCRIPT_DIR/run-random.sh" --dry-run
  exit 0
fi

if [[ "$IMMEDIATE" != "true" ]]; then
  sleep "$DELAY"
fi

"$SCRIPT_DIR/run-random.sh" --dry-run
PICK=$(python3 -c "import json; print(json.load(open('$SCRIPT_DIR/last-random.json'))['project'])")
echo "[$(date)] Starting project: $PICK"
"$SCRIPT_DIR/$PICK/run.sh" --background
campaign_record_run "$PICK"
echo "[$(date)] Campaign run recorded for $PICK"
