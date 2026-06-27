#!/usr/bin/env bash
# Bootstrap token-burn in a fresh or existing environment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$SCRIPT_DIR/env.sh" ]] && source "$SCRIPT_DIR/env.sh"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
CRON_LINE="0 9 * * * $SCRIPT_DIR/run-daily-campaign.sh >> $LOG_DIR/campaign.log 2>&1"

INSTALL_CRON=true
RESET_CAMPAIGN=true
RUN_NOW=false
PULL=true

usage() {
  cat <<EOF
Usage: ./bootstrap.sh [options]

Prepare and start the 3-day token-burn schedule in this environment.

Options:
  --no-cron        Do not install crontab entry
  --no-reset       Keep existing campaign.json window
  --now            Run today's job immediately (still random 9-15 delay unless --immediate)
  --immediate      With --now: skip random delay and start a repo now
  --no-pull        Skip git pull in register-phone repo
  -h, --help       Show this help

Typical first-time setup (from anywhere):
  git clone git@github.com:caokangx/register-phone.git ~/Documents/register-phone \\
    && ~/Documents/register-phone/token-burn/bootstrap.sh
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-cron) INSTALL_CRON=false; shift ;;
    --no-reset) RESET_CAMPAIGN=false; shift ;;
    --now) RUN_NOW=true; shift ;;
    --immediate) RUN_NOW=true; IMMEDIATE=true; shift ;;
    --no-pull) PULL=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

IMMEDIATE="${IMMEDIATE:-false}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd git
need_cmd python3
need_cmd claude

echo "==> Repo: $REPO_DIR"
echo "==> Token burn: $SCRIPT_DIR"

if $PULL && [[ -d "$REPO_DIR/.git" ]]; then
  echo "==> Updating register-phone..."
  git -C "$REPO_DIR" pull --ff-only 2>/dev/null || echo "    (git pull skipped or failed; continuing)"
fi

chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null || true
for d in "$SCRIPT_DIR"/*/; do
  [[ -f "$d/run.sh" ]] && chmod +x "$d/run.sh"
done
mkdir -p "$LOG_DIR"

if [[ ! -f "$SCRIPT_DIR/env.sh" && -f "$SCRIPT_DIR/env.example.sh" ]]; then
  cp "$SCRIPT_DIR/env.example.sh" "$SCRIPT_DIR/env.sh"
  echo "==> Created env.sh from env.example.sh (edit proxy/HOME if needed)"
fi

cd "$SCRIPT_DIR"

if $RESET_CAMPAIGN; then
  echo "==> Reset 3-day campaign window..."
  ./run-daily-campaign.sh --reset
else
  echo "==> Campaign status (no reset):"
  ./run-daily-campaign.sh --status
fi

if $INSTALL_CRON; then
  echo "==> Installing crontab (daily 09:00 trigger)..."
  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -v 'run-daily-campaign.sh' > "$tmp" || true
  echo "$CRON_LINE" >> "$tmp"
  crontab "$tmp"
  rm -f "$tmp"
  echo "    Crontab installed:"
  crontab -l | grep run-daily-campaign.sh || true
fi

if $RUN_NOW; then
  if [[ "$IMMEDIATE" == "true" ]]; then
    echo "==> Starting today's campaign immediately (no 9-15 delay)..."
    ./run-daily-campaign.sh --immediate
  else
    echo "==> Starting today's campaign run in background (with 9-15 random delay)..."
    nohup ./run-daily-campaign.sh >> "$LOG_DIR/campaign.log" 2>&1 &
    echo "    PID: $!"
  fi
fi

echo ""
echo "==> Ready."
echo "    Status:  $SCRIPT_DIR/status.sh"
echo "    Campaign: $SCRIPT_DIR/run-daily-campaign.sh --status"
echo "    Logs:    tail -f $LOG_DIR/campaign.log"
echo "    Dry run: $SCRIPT_DIR/run-daily-campaign.sh --dry-run"
