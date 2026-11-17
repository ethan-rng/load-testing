#!/usr/bin/env bash
# Runs a load test and writes a summary JSON and an HTML report to results/.
#
#   ./run.sh                                  # naive, local dev, 10 VUs, 30s
#   MODE=naive VUS=50 DURATION=2m TARGET=https://dev.hackwestern.com ./run.sh
#
# Settings are plain env vars: TARGET MODE PHASE VUS DURATION RAMP_UP
# ALLOW_MUTATIONS TEST_EMAIL TEST_PASSWORD ALLOWED_HOSTS.
set -euo pipefail
cd "$(dirname "$0")"

MODE="${MODE:-naive}"
PHASE="${PHASE:-during}"
VUS="${VUS:-10}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
TEST_ID="${TEST_ID:-${STAMP}_${MODE}_${PHASE}_${VUS}vu}"

mkdir -p results
export K6_WEB_DASHBOARD_EXPORT="results/${TEST_ID}.html"

# Pass every setting through to the script.
ENVS=()
for v in TARGET MODE PHASE VUS DURATION RAMP_UP ALLOW_MUTATIONS TEST_EMAIL TEST_PASSWORD ALLOWED_HOSTS; do
  if [ -n "${!v:-}" ]; then ENVS+=(-e "$v=${!v}"); fi
done
ENVS+=(-e "TEST_ID=${TEST_ID}" -e "MODE=${MODE}" -e "PHASE=${PHASE}" -e "VUS=${VUS}")

echo "Run: ${TEST_ID}"
K6_WEB_DASHBOARD="${K6_WEB_DASHBOARD:-true}" \
K6_WEB_DASHBOARD_PORT="${K6_WEB_DASHBOARD_PORT:--1}" \
  k6 run "${ENVS[@]}" \
    --summary-export="results/${TEST_ID}.json" \
    src/main.ts
