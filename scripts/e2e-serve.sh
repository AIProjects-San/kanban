#!/bin/bash
# QA helper — boot the dev server, wait for health, run the given cucumber-js
# args, then stop the server. The sandbox reaps background processes when a
# tool call ends, so the server and the test run must share ONE call.
#
# Usage: bash scripts/e2e-serve.sh [--tags "@hr-qa"] [extra cucumber args...]
set -uo pipefail

cd /home/z/my-project

# --- 0. Kill any stale server on :3000 ---------------------------------------
# A dev server left behind by a previous (timed-out / killed) run makes the
# health check pass against the OLD process, while the NEW `next dev` fails
# to bind (EADDRINUSE, unnoticed). When the sandbox later reaps the stale
# process, every remaining scenario dies with ERR_CONNECTION_REFUSED. Clear
# the port first so this run owns its server.
STALE_PIDS=""
if command -v lsof >/dev/null 2>&1; then
  STALE_PIDS="$(lsof -t -i :3000 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  STALE_PIDS="$(fuser 3000/tcp 2>/dev/null || true)"
fi
if [ -n "${STALE_PIDS// /}" ]; then
  echo "=== killing stale server on :3000 (pid(s): $STALE_PIDS) ==="
  # shellcheck disable=SC2086
  kill $STALE_PIDS 2>/dev/null || true
  sleep 2
fi

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
# Chrome lives under /home/z/.agent-browser/browsers/chrome-<version>/chrome,
# and the version drifts when the sandbox recycles. Auto-detect the newest
# installed build instead of pinning a path that silently rots.
CHROME_CANDIDATES=()
for c in /home/z/.agent-browser/browsers/chrome-*/chrome; do
  [ -x "$c" ] && CHROME_CANDIDATES+=("$c")
done
if [ "${#CHROME_CANDIDATES[@]}" -gt 0 ]; then
  export CHROME_BIN="${CHROME_BIN:-${CHROME_CANDIDATES[-1]}}"
fi
export SELENIUM_HEADLESS=1
npx cucumber-js -c e2e/cucumber.cjs "$@"
CUCUMBER_EXIT=$?

# --- 4. Stop the server -----------------------------------------------------
kill "$DEVSH_PID" 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 1

exit $CUCUMBER_EXIT
