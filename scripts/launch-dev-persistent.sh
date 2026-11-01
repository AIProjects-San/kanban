#!/usr/bin/env bash
# Persistent dev-server launcher for the kanban project inside this sandbox.
# Uses setsid + nohup + </dev/null + disown so the server survives the
# parent shell teardown, since the sandbox recycles background processes
# between bash calls.
set -euo pipefail

PROJECT_ROOT="/home/z/my-project"
LOG_FILE="/tmp/fernly-dev.log"
PID_FILE="/tmp/fernly-dev.pid"

# Kill anything left on port 3000.
pkill -f "next dev -p 3000" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
sleep 1

cd "$PROJECT_ROOT"

# Export env from .env so Prisma + NextAuth pick it up.
set -a
source .env
set +a

# Fully detach: new session (setsid), ignore SIGHUP (nohup), no stdin,
# disown so the parent shell doesn't wait.
setsid nohup bun run dev > "$LOG_FILE" 2>&1 < /dev/null &
DEV_PID=$!
disown 2>/dev/null || true
echo "$DEV_PID" > "$PID_FILE"
echo "Launched dev server, PID=$DEV_PID, log=$LOG_FILE"

# Wait up to 60s for Next.js to bind (first compile can be slow).
READY=0
for i in $(seq 1 60); do
  # curl prints "%{http_code}" as "000" on connection failure — do NOT add
  # `|| echo "000"` (it doubles the output and confuses the check).
  # `|| true` is critical: under `set -e`, curl's non-zero exit on
  # connection-refused (code 7) would abort the whole script. We handle
  # failure explicitly by treating empty CODE as "000".
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 http://localhost:3000/ 2>/dev/null || true)
  [[ -z "$CODE" ]] && CODE="000"
  if [[ "$CODE" != "000" ]]; then
    READY=1
    echo "Dev server bound on :3000 after ${i}s (HTTP $CODE on /)"
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "Dev server process exited early at ${i}s — showing log tail:" >&2
    tail -30 "$LOG_FILE" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$READY" != "1" ]]; then
  echo "Dev server did not bind in 60s — showing log tail:" >&2
  tail -30 "$LOG_FILE" >&2
  exit 1
fi

echo "---health endpoint---"
curl -s -o /tmp/h.out -w "HTTP %{http_code}\n" --max-time 5 http://localhost:3000/api/health || echo "no response"
head -c 400 /tmp/h.out 2>/dev/null; echo
echo "---homepage title---"
curl -s --max-time 30 http://localhost:3000/ | grep -oE "<title>[^<]*</title>" | head -1 || echo "(no title)"
echo "---log head---"
head -15 "$LOG_FILE"
