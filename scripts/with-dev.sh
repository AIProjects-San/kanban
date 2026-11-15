#!/usr/bin/env bash
# with-dev.sh — run a command against a freshly-spawned dev server on :3001
# within a single tool call (the sandbox reaper kills background processes
# ~45s after the spawning call ends, so the server and its client must share
# one call). Usage: bash scripts/with-dev.sh <command...>
set -uo pipefail
cd /home/z/my-project
pkill -f 'next dev' 2>/dev/null
pkill -f 'next-server' 2>/dev/null
sleep 1
rm -f dev.log
set -a; . ./.env; set +a
export NODE_ENV=development NODE_OPTIONS='--max-old-space-size=1228'
setsid nohup bash -c 'export PATH="/home/z/my-project/node_modules/.bin:$PATH"; bash scripts/run-with-env.sh next dev -p 3001 2>&1 | tee dev.log' > /tmp/dev-outer.log 2>&1 < /dev/null &
disown
up=0
for i in $(seq 1 45); do
  sleep 2
  if curl -sf -m 15 http://localhost:3001/api/health > /dev/null 2>&1; then up=1; break; fi
done
if [ "$up" != "1" ]; then echo "DEV-FAILED-TO-START"; tail -20 dev.log 2>/dev/null; exit 1; fi
echo "DEV-UP"
"$@"
exit $?
