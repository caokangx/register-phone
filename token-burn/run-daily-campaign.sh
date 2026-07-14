#!/usr/bin/env bash
# 3-day campaign: one random repo every 30 minutes, max 25 runs per day.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/env.sh" ]] && source "$SCRIPT_DIR/env.sh"
CAMPAIGN_FILE="${CAMPAIGN_FILE:-$SCRIPT_DIR/campaign.json}"
LOG_DIR="$SCRIPT_DIR/logs"
CAMPAIGN_DAYS="${CAMPAIGN_DAYS:-3}"
RUNS_PER_DAY="${RUNS_PER_DAY:-25}"

mkdir -p "$LOG_DIR"

usage() {
  cat <<EOF
Usage: ./run-daily-campaign.sh [options]

3-day schedule, 25 runs per day:
  cron every 30 minutes from 09:00 through 21:00
  each trigger starts one random repo immediately

Options:
  --reset       Clear campaign and start a new 3-day window today
  --status      Show campaign state
  --dry-run     Preview without starting
  --immediate   Compatibility no-op; runs are already immediate
  --slot NAME   Compatibility no-op; slots are no longer used
  -h, --help    Show this help

Cron (recommended):
  0,30 9-20 * * * $SCRIPT_DIR/run-daily-campaign.sh >> $LOG_DIR/campaign.log 2>&1
  0 21 * * * $SCRIPT_DIR/run-daily-campaign.sh >> $LOG_DIR/campaign.log 2>&1
EOF
}

campaign_py() {
  python3 - "$CAMPAIGN_FILE" "$CAMPAIGN_DAYS" "$RUNS_PER_DAY" "$@" <<'PY'
import json, sys
from datetime import date, datetime, timedelta
from pathlib import Path

path = Path(sys.argv[1])
max_days = int(sys.argv[2])
runs_per_day = int(sys.argv[3])
cmd = sys.argv[4]
today = date.today()
today_s = today.isoformat()

def load():
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        start = date.fromisoformat(data["start_date"])
    else:
        start = today
        data = {
            "start_date": start.isoformat(),
            "end_date": (start + timedelta(days=max_days - 1)).isoformat(),
            "max_days": max_days,
            "schedule": {
                "runs_per_day": runs_per_day,
                "interval_minutes": 30,
                "cron": "0,30 9-20 * * *; 0 21 * * *",
                "window": "09:00-21:00",
            },
            "runs": [],
        }
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    data["max_days"] = max_days
    data["schedule"] = {
        "runs_per_day": runs_per_day,
        "interval_minutes": 30,
        "cron": "0,30 9-20 * * *; 0 21 * * *",
        "window": "09:00-21:00",
    }
    end = date.fromisoformat(data.get("end_date", (start + timedelta(days=max_days - 1)).isoformat()))
    data["_start"] = start
    data["_end"] = end
    data["_today"] = today
    data["_active"] = start <= today <= end
    data["_day_number"] = (today - start).days + 1 if today >= start else 0
    data["_days_remaining"] = max(0, (end - today).days + 1) if data["_active"] else 0
    return data

def status_payload(data):
    today_runs = runs_today(data)
    return {
        **{k: v for k, v in data.items() if not k.startswith("_")},
        "today": data["_today"].isoformat(),
        "active": data["_active"],
        "day_number": data["_day_number"],
        "days_remaining": data["_days_remaining"],
        "runs_today": len(today_runs),
        "runs_remaining_today": max(0, runs_per_day - len(today_runs)) if data["_active"] else 0,
        "next_run_number": len(today_runs) + 1 if data["_active"] and len(today_runs) < runs_per_day else None,
    }

def runs_today(data):
    return [r for r in data.get("runs", []) if r.get("local_date") == today_s]

def can_run(data):
    return data["_active"] and len(runs_today(data)) < runs_per_day

if cmd == "read":
    print(json.dumps(status_payload(load()), ensure_ascii=False))
elif cmd == "can_run":
    print("yes" if can_run(load()) else "no")
elif cmd == "record":
    project = sys.argv[5]
    data = load()
    run_number = len(runs_today(data)) + 1
    data.setdefault("runs", []).append({
        "at": datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z"),
        "local_date": today_s,
        "run_number": run_number,
        "project": project,
    })
    clean = {k: v for k, v in data.items() if not k.startswith("_")}
    path.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"recorded": project, "run_number": run_number, "local_date": today_s}, ensure_ascii=False))
else:
    raise SystemExit(f"unknown cmd: {cmd}")
PY
}

campaign_read() { campaign_py read; }
campaign_can_run() { campaign_py can_run; }
campaign_record_run() { campaign_py record "$1"; }

campaign_reset() {
  rm -f "$CAMPAIGN_FILE"
  campaign_read > /dev/null
  echo "Campaign reset. New 3-day window (${RUNS_PER_DAY} runs/day) starts today."
  python3 "$SCRIPT_DIR/pretty-json.py" "$CAMPAIGN_FILE"
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
    --slot)
      [[ -n "${2:-}" ]] || { echo "--slot requires a value" >&2; exit 1; }
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if $RESET; then
  campaign_reset
  exit 0
fi

if $SHOW_STATUS; then
  campaign_read | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=2))"
  exit 0
fi

STATE=$(campaign_read)
ACTIVE=$(echo "$STATE" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin)['active'] else 'no')")
START=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['start_date'])")
END=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['end_date'])")
DAY=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['day_number'])")
RUNS_TODAY=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['runs_today'])")
REMAINING=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['runs_remaining_today'])")
NEXT_RUN=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next_run_number') or '')")

if [[ "$ACTIVE" != "yes" ]]; then
  echo "[$(date)] Campaign inactive (window: $START → $END). Skip."
  exit 0
fi

if [[ "$REMAINING" -le 0 ]]; then
  echo "[$(date)] Daily limit reached ($RUNS_TODAY/$RUNS_PER_DAY). Skip."
  exit 0
fi

echo "[$(date)] Campaign day $DAY/$CAMPAIGN_DAYS | run $NEXT_RUN/$RUNS_PER_DAY | immediate start"

if $DRY_RUN; then
  echo "$STATE" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=2))"
  echo "Would run round $NEXT_RUN/$RUNS_PER_DAY"
  "$SCRIPT_DIR/run-random.sh" --skip-running --dry-run
  exit 0
fi

"$SCRIPT_DIR/run-random.sh" --skip-running --dry-run
PICK=$(python3 -c "import json; print(json.load(open('$SCRIPT_DIR/last-random.json'))['project'])")
echo "[$(date)] Starting project: $PICK (run=$NEXT_RUN/$RUNS_PER_DAY)"
"$SCRIPT_DIR/$PICK/run.sh" --background
campaign_record_run "$PICK"
echo "[$(date)] Campaign run recorded: $PICK run=$NEXT_RUN/$RUNS_PER_DAY"
