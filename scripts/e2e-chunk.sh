#!/usr/bin/env bash
# Chunked local e2e runner — writes output to a log and records the exit code
# (cucumber buffers its formatters, so a killed run leaves no summary).
# Usage: E2E_ONLY="e2e/features/a.feature,e2e/features/b.feature" bash scripts/e2e-chunk.sh
set -u
cd "$(dirname "$0")/.."
# P39 verification note: SELENIUM_REMOTE_URL defaults to the standalone
# chromedriver at :9515 ONLY when the caller did not export an override.
# The sandbox has no standalone driver — pass E2E_NO_REMOTE=1 to let
# Selenium Manager resolve the local Chrome directly (the e2e-serve.sh
# discipline), while CI keeps the default.
if [ "${E2E_NO_REMOTE:-0}" = "1" ]; then
  unset SELENIUM_REMOTE_URL
else
  export SELENIUM_REMOTE_URL="${SELENIUM_REMOTE_URL:-http://localhost:9515}"
fi
# Auto-detect the sandbox Chrome (e2e-serve.sh's discipline) when the
# unpacked .chrome-e2e copy is absent.
if [ ! -x "$(pwd)/.chrome-e2e/chrome-linux64/chrome" ]; then
  for c in /home/z/.agent-browser/browsers/chrome-*/chrome; do
    [ -x "$c" ] && export CHROME_BIN="${CHROME_BIN:-$c}"
  done
fi
export SELENIUM_HEADLESS="${SELENIUM_HEADLESS:-1}"
export BASE_URL="${BASE_URL:-http://localhost:3000}"
LOG="${E2E_LOG:-e2e-chunk.log}"
echo "[e2e-chunk] features: ${E2E_ONLY:-ALL} — $(date)" > "$LOG"
npx cucumber-js -c e2e/cucumber.only.cjs >> "$LOG" 2>&1
code=$?
echo "[e2e-chunk] exit=$code — $(date)" >> "$LOG"
pkill -f chrome-linux64 2>/dev/null
exit $code
