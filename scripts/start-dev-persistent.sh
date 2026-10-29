#!/usr/bin/env bash
# Persistent dev-server launcher. Uses setsid + nohup so the server survives
# the parent shell teardown, and redirects output to /tmp/fernly-dev.log.
# Loads .env explicitly so Prisma can reach Supabase even if the parent
# shell didn't export it.
set -euo pipefail

# Kill anything left on port 3000.
pkill -f "next dev -p 3000" 2>/dev/null || true
sleep 1

cd /home/z/my-project
set -a
source .env
set +a

# setsid detaches from the controlling terminal; nohup + disown shield SIGHUP.
setsid nohup bunx next dev -p 3000 > /tmp/fernly-dev.log 2>&1 < /dev/null &
disown

# Wait up to 30s for the server to bind.
for i in $(seq 1 30); do
  if curl -sS -o /dev/null --max-time 1 http://localhost:3000/ 2>/dev/null; then
    echo "Dev server ready after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "Dev server failed to come up in 30s" >&2
tail -20 /tmp/fernly-dev.log >&2
exit 1
