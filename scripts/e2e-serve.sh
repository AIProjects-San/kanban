#!/bin/bash
# QA helper — boot the dev server, wait for health, run the given cucumber-js
# args, then stop the server. The sandbox reaps background processes when a
# tool call ends, so the server and the test run must share ONE call.
#
# Usage: bash scripts/e2e-serve.sh [--tags "@hr-qa"] [extra cucumber args...]
set -uo pipefail

cd /home/z/my-project

# --- 1. Boot the dev server (logs to .zscripts/dev.log via dev.sh) ---------
bash .zscripts/dev.sh > /tmp/e2e-serve-dev.log 2>&1 &
DEVSH_PID=$!

# --- 2. Wait for /api/health -----------------------------------------------
healthy=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/health 2>/dev/null)
  if [ "$code" = "200" ]; then healthy=1; break; fi
  sleep 3
done

if [ "$healthy" != "1" ]; then
  echo "SERVER FAILED TO BOOT — dev log tail:"
  tail -30 /tmp/e2e-serve-dev.log
  tail -30 .zscripts/dev.log 2>/dev/null
  kill "$DEVSH_PID" 2>/dev/null
  exit 1
fi
echo "=== dev server healthy ==="

# --- 3. Run cucumber with the passed args ----------------------------------
export CHROME_BIN="${CHROME_BIN:-/home/z/.agent-browser/browsers/chrome-156.0.8078.73/chrome}"
export SELENIUM_HEADLESS=1
npx cucumber-js -c e2e/cucumber.cjs "$@"
CUCUMBER_EXIT=$?

# --- 4. Stop the server -----------------------------------------------------
kill "$DEVSH_PID" 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 1

exit $CUCUMBER_EXIT
