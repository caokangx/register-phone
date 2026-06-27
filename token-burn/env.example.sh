# Copy to env.sh and adjust for your machine:
#   cp env.example.sh env.sh
#
# Cron does NOT load your interactive shell profile.
# This file is sourced by run-daily-campaign.sh, run-random.sh, and bootstrap.sh.

export HOME="${HOME:-/home/coder}"
export PATH="${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin"
export http_proxy="${http_proxy:-http://192.168.3.100:1084}"
export https_proxy="${https_proxy:-http://192.168.3.100:1084}"
