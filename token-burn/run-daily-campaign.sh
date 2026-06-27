#!/usr/bin/env bash
# 3-day campaign: twice daily (09:00–12:00 and 14:00–18:00), one random repo per slot.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/env.sh" ]] && source "$SCRIPT_DIR/env.sh"
CAMPAIGN_FILE="${CAMPAIGN_FILE:-$SCRIPT_DIR/campaign.json}"
LOG_DIR="$SCRIPT_DIR/logs"
CAMPAIGN_DAYS="${CAMPAIGN_DAYS:-3}"

slot_window_seconds() {
  case "$1" in
    morning) echo 10800 ;;    # 3h: 09:00–12:00
    afternoon) echo 14400 ;;  # 4h: 14:00–18:00
    *) echo 0 ;;
  esac
}

slot_label() {
  case "$1" in
    morning) echo "09:00–12:00" ;;
    afternoon) echo "14:00–18:00" ;;
    *) echo "unknown" ;;
  esac
}

mkdir -p "$LOG_DIR"

usage() {
  cat <<EOF
Usage: ./run-daily-campaign.sh [options]

3-day schedule, 2 runs per day:
  morning   cron 09:00 + random 0–3h  → start between 09:00–12:00
  afternoon cron 14:00 + random 0–4h  → start between 14:00–18:00

Options:
  --slot morning|afternoon   Required for cron; which time window to run
  --reset                    Clear campaign and start a new 3-day window today
  --status                   Show campaign state
  --dry-run                  Preview without sleeping or starting
  --immediate                Skip random delay for this slot (still records run)
  -h, --help                 Show this help

Cron (recommended):
  0 9  * * * $SCRIPT_DIR/run-daily-campaign.sh --slot morning   >> $LOG_DIR/campaign.log 2>&1
  0 14 * * * $SCRIPT_DIR/run-daily-campaign.sh --slot afternoon >> $LOG_DIR/campaign.log 2>&1
EOF
}

campaign_py() {
  python3 - "$CAMPAIGN_FILE" "$CAMPAIGN_DAYS" "$@" <<'PY'
import json, sys
from datetime import date, datetime, timedelta
from pathlib import Path

path = Path(sys.argv[1])
max_days = int(sys.argv[2])
cmd = sys.argv[3]
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
                "runs_per_day": 2,
                "morning": "09:00-12:00",
                "afternoon": "14:00-18:00",
            },
            "runs": [],
        }
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    end = date.fromisoformat(data.get("end_date", (start + timedelta(days=max_days - 1)).isoformat()))
    data["_start"] = start
    data["_end"] = end
    data["_today"] = today
    data["_active"] = start <= today <= end
    data["_day_number"] = (today - start).days + 1 if today >= start else 0
    data["_days_remaining"] = max(0, (end - today).days + 1) if data["_active"] else 0
    return data

def status_payload(data):
    return {
        **{k: v for k, v in data.items() if not k.startswith("_")},
        "today": data["_today"].isoformat(),
        "active": data["_active"],
        "day_number": data["_day_number"],
        "days_remaining": data["_days_remaining"],
        "slots_today": slots_today(data),
    }

def slots_today(data):
    done = {r.get("slot") for r in data.get("runs", []) if r.get("local_date") == today_s}
    return {
        "morning": "done" if "morning" in done else "pending",
        "afternoon": "done" if "afternoon" in done else "pending",
    }

def slot_done(data, slot):
    return any(r.get("local_date") == today_s and r.get("slot") == slot for r in data.get("runs", []))

if cmd == "read":
    print(json.dumps(status_payload(load()), ensure_ascii=False))
elif cmd == "slot_done":
    slot = sys.argv[4]
    print("yes" if slot_done(load(), slot) else "no")
elif cmd == "record":
    slot, project = sys.argv[4], sys.argv[5]
    data = load()
    data.setdefault("runs", []).append({
        "at": datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z"),
        "local_date": today_s,
        "slot": slot,
        "project": project,
    })
    clean = {k: v for k, v in data.items() if not k.startswith("_")}
    path.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"recorded": project, "slot": slot, "local_date": today_s}, ensure_ascii=False))
else:
    raise SystemExit(f"unknown cmd: {cmd}")
PY
}

campaign_read() { campaign_py read; }
campaign_slot_done() { campaign_py slot_done "$1"; }
campaign_record_run() { campaign_py record "$1" "$2"; }

campaign_reset() {
  rm -f "$CAMPAIGN_FILE"
  campaign_read > /dev/null
  echo "Campaign reset. New 3-day window (2 runs/day) starts today."
  python3 "$SCRIPT_DIR/pretty-json.py" "$CAMPAIGN_FILE"
}

RESET=false
DRY_RUN=false
SHOW_STATUS=false
IMMEDIATE=false
SLOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset) RESET=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --status) SHOW_STATUS=true; shift ;;
    --immediate) IMMEDIATE=true; shift ;;
    --slot)
      SLOT="${2:-}"
      [[ -n "$SLOT" ]] || { echo "--slot requires morning or afternoon" >&2; exit 1; }
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

if [[ -z "$SLOT" ]]; then
  echo "Missing --slot morning|afternoon" >&2
  usage
  exit 1
fi

WINDOW_SECONDS=$(slot_window_seconds "$SLOT")
if [[ "$WINDOW_SECONDS" -eq 0 ]]; then
  echo "Invalid slot: $SLOT (use morning or afternoon)" >&2
  exit 1
fi

STATE=$(campaign_read)
ACTIVE=$(echo "$STATE" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin)['active'] else 'no')")
START=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['start_date'])")
END=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['end_date'])")
DAY=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['day_number'])")

if [[ "$ACTIVE" != "yes" ]]; then
  echo "[$(date)] Campaign inactive (window: $START → $END). Skip slot=$SLOT."
  exit 0
fi

if [[ "$(campaign_slot_done "$SLOT")" == "yes" ]]; then
  echo "[$(date)] Slot '$SLOT' already completed today ($START → $END). Skip."
  exit 0
fi

WINDOW_SECONDS=$(slot_window_seconds "$SLOT")
DELAY=$((RANDOM % (WINDOW_SECONDS + 1)))
DELAY_H=$((DELAY / 3600))
DELAY_M=$(((DELAY % 3600) / 60))
LABEL=$(slot_label "$SLOT")

if [[ "$IMMEDIATE" == "true" ]]; then
  echo "[$(date)] Campaign day $DAY/3 | slot=$SLOT ($LABEL) | immediate start"
else
  echo "[$(date)] Campaign day $DAY/3 | slot=$SLOT ($LABEL) | random delay ${DELAY_H}h ${DELAY_M}m"
fi

if $DRY_RUN; then
  echo "$STATE" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin), ensure_ascii=False, indent=2))"
  echo "Would run slot=$SLOT ($LABEL)"
  "$SCRIPT_DIR/run-random.sh" --dry-run
  exit 0
fi

if [[ "$IMMEDIATE" != "true" ]]; then
  sleep "$DELAY"
fi

"$SCRIPT_DIR/run-random.sh" --dry-run
PICK=$(python3 -c "import json; print(json.load(open('$SCRIPT_DIR/last-random.json'))['project'])")
echo "[$(date)] Starting project: $PICK (slot=$SLOT)"
"$SCRIPT_DIR/$PICK/run.sh" --background
campaign_record_run "$SLOT" "$PICK"
echo "[$(date)] Campaign run recorded: $PICK slot=$SLOT"
