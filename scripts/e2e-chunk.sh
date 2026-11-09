#!/usr/bin/env bash
# Chunked local e2e runner — writes output to a log and records the exit code
# (cucumber buffers its formatters, so a killed run leaves no summary).
# Usage: E2E_ONLY="e2e/features/a.feature,e2e/features/b.feature" bash scripts/e2e-chunk.sh
set -u
cd "$(dirname "$0")/.."
export SELENIUM_REMOTE_URL="${SELENIUM_REMOTE_URL:-http://localhost:9515}"
export CHROME_BIN="${CHROME_BIN:-$(pwd)/.chrome-e2e/chrome-linux64/chrome}"
export SELENIUM_HEADLESS="${SELENIUM_HEADLESS:-1}"
export BASE_URL="${BASE_URL:-http://localhost:3000}"
LOG="${E2E_LOG:-e2e-chunk.log}"
echo "[e2e-chunk] features: ${E2E_ONLY:-ALL} — $(date)" > "$LOG"
bunx cucumber-js -c e2e/cucumber.only.cjs >> "$LOG" 2>&1
code=$?
echo "[e2e-chunk] exit=$code — $(date)" >> "$LOG"
pkill -f chrome-linux64 2>/dev/null
exit $code
