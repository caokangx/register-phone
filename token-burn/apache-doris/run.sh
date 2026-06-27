#!/usr/bin/env bash
# Auto-generated runner for Doris
# Usage:
#   ./run.sh              # foreground
#   ./run.sh --background # background with progress tracking
#   ./run.sh --status     # show progress
#   ./run.sh --stop       # stop background run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_BURN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[[ -f "$TOKEN_BURN_DIR/env.sh" ]] && source "$TOKEN_BURN_DIR/env.sh"
PROJECT_ID="apache-doris"
REPO_URL="https://github.com/apache/doris.git"
PROJECT_NAME="apache-doris"
WORK_DIR="${WORK_DIR:-$SCRIPT_DIR/workspace}"
CLONE_DIR="$WORK_DIR/$PROJECT_NAME"
LOG_DIR="$SCRIPT_DIR/logs"
PROGRESS_FILE="$SCRIPT_DIR/progress.json"
PID_FILE="$SCRIPT_DIR/run.pid"
TASKS_FILE="$SCRIPT_DIR/tasks.txt"
MAIN_LOG="$LOG_DIR/main.log"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
CLAUDE_FLAGS=(
  --permission-mode auto
  --max-turns 50
)
# Uncomment to cap cost per task:
# CLAUDE_FLAGS+=(--max-budget-usd 2)

mkdir -p "$LOG_DIR" "$WORK_DIR"

write_progress() {
  local current="$1" total="$2" status="$3" last_task="$4"
  python3 - "$PROGRESS_FILE" "$PROJECT_ID" "$current" "$total" "$status" "$last_task" "$LOG_DIR" "$CLONE_DIR" "$PID_FILE" <<'PY'
import json, sys
from datetime import datetime, timezone
out, project, current, total, status, last_task, log_dir, clone_dir, pid_file = sys.argv[1:10]
try:
    pid = int(open(pid_file).read().strip())
except Exception:
    pid = None
data = {
    "project": project,
    "current": int(current),
    "total": int(total),
    "percent": round(100 * int(current) / max(int(total), 1), 1),
    "status": status,
    "last_task": last_task,
    "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "pid": pid,
    "log_dir": log_dir,
    "clone_dir": clone_dir,
}
open(out, "w").write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY
}

show_status() {
  if [[ -f "$PROGRESS_FILE" ]]; then
    python3 - "$PROGRESS_FILE" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path, encoding="utf-8"))
print(f"Project: {d['project']} | Task {d['current']}/{d['total']} ({d['percent']}%) | {d['status']}")
if d.get("last_task"):
    print(d["last_task"])
print()
print(json.dumps(d, ensure_ascii=False, indent=2))
PY
  else
    echo "No progress yet. Run ./run.sh first."
  fi
  echo ""
  echo "Tail main log: tail -f $MAIN_LOG"
  echo "Tail latest task: ls -t $LOG_DIR/task_*.log 2>/dev/null | head -1 | xargs tail -f"
}

stop_run() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && echo "Stopped PID $pid"
    else
      echo "Process $pid not running"
    fi
    rm -f "$PID_FILE"
  else
    echo "No PID file"
  fi
}

clone_repo() {
  if [[ -d "$CLONE_DIR/.git" ]]; then
    echo "[$(date)] Repo exists, fetching latest (shallow)..." | tee -a "$MAIN_LOG"
    git -C "$CLONE_DIR" fetch --depth 1 origin 2>&1 | tee -a "$MAIN_LOG" || true
    git -C "$CLONE_DIR" checkout -f HEAD 2>&1 | tee -a "$MAIN_LOG" || true
  else
    echo "[$(date)] Cloning $REPO_URL ..." | tee -a "$MAIN_LOG"
    git clone --depth 1 "$REPO_URL" "$CLONE_DIR" 2>&1 | tee -a "$MAIN_LOG"
  fi
}

run_tasks() {
  cd "$CLONE_DIR"
  local total=100
  local current=0
  local first=true
  local session_id=""

  write_progress 0 "$total" "running" ""

  while IFS= read -r prompt || [[ -n "$prompt" ]]; do
    [[ -z "$prompt" ]] && continue
    current=$((current + 1))
    local task_log="$LOG_DIR/task_$(printf '%03d' "$current").log"

    echo "" | tee -a "$MAIN_LOG"
    echo "========== [$PROJECT_ID] Task $current/$total ==========" | tee -a "$MAIN_LOG"
    echo "$prompt" | tee -a "$MAIN_LOG"
    write_progress "$current" "$total" "running" "$prompt"

    set +e
    if $first; then
      "$CLAUDE_BIN" -p "$prompt" "${CLAUDE_FLAGS[@]}" --output-format json 2>&1 | tee "$task_log" || true
      session_id=$(python3 -c "import json,sys; d=json.load(open('$task_log')); print(d.get('session_id',''))" 2>/dev/null || echo "")
      first=false
    else
      if [[ -n "$session_id" ]]; then
        "$CLAUDE_BIN" -p "$prompt" --resume "$session_id" "${CLAUDE_FLAGS[@]}" --output-format json 2>&1 | tee "$task_log" || true
      else
        "$CLAUDE_BIN" -p "$prompt" --continue "${CLAUDE_FLAGS[@]}" --output-format json 2>&1 | tee "$task_log" || true
      fi
    fi
    set -e

    echo "[$(date)] Task $current/$total done" | tee -a "$MAIN_LOG"
  done < "$TASKS_FILE"

  write_progress "$total" "$total" "completed" "All 100 tasks finished"
  rm -f "$PID_FILE"
  echo "[$(date)] All tasks completed for $PROJECT_ID" | tee -a "$MAIN_LOG"
}

case "${1:-}" in
  --background|-b)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "Already running PID $(cat "$PID_FILE")"
      exit 1
    fi
    nohup "$0" --foreground >> "$MAIN_LOG" 2>&1 &
    echo $! > "$PID_FILE"
    write_progress 0 100 "starting" "Background launch"
    echo "Started $PROJECT_ID in background, PID=$(cat "$PID_FILE")"
    echo "Progress: $0 --status"
    echo "Logs:     tail -f $MAIN_LOG"
    ;;
  --status|-s)
    show_status
    ;;
  --stop)
    stop_run
    ;;
  --foreground|-f|"")
    clone_repo
    run_tasks
    ;;
  *)
    echo "Usage: $0 [--background|--status|--stop|--foreground]"
    exit 1
    ;;
esac
