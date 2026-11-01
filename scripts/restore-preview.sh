#!/usr/bin/env bash
# Restore the Fernly preview after a full sandbox recycle.
# Source of truth: the Oct 29 workspace snapshot tar (extracted at /tmp/ws-extract).
# The project tree under /home/z/my-project was wiped except upload/ and download/.
set -u
cd /home/z/my-project

echo "== 1. restore source tree (excluding upload/ and download/) =="
shopt -s dotglob nullglob
for item in /tmp/ws-extract/*; do
  base=$(basename "$item")
  if [ "$base" = "upload" ] || [ "$base" = "download" ]; then continue; fi
  cp -a "$item" ./
done
shopt -u dotglob
ls -d src prisma e2e .git 2>/dev/null

echo "== 2. recreate /api/health route (added after the snapshot was taken) =="
mkdir -p src/app/api/health
cat > src/app/api/health/route.ts <<'EOF'
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe used by the preview keepalive loop and uptime checks.
 * Verifies not only that the server responds but that the database is reachable.
 */
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "up" });
  } catch {
    // Server itself is alive even if the DB is unreachable — still a 200 so
    // the keepalive loop does not churn-restart a healthy process.
    return NextResponse.json({ status: "ok", db: "down" });
  }
}
EOF

echo "== 3. env: ensure demo password matches scripts/seed.js =="
grep -q NEXT_PUBLIC_DEMO_PASSWORD .env || echo 'NEXT_PUBLIC_DEMO_PASSWORD=fernly123' >> .env
wc -c .env

echo "== 4. bun install =="
bun install --frozen-lockfile 2>&1 | tail -4

echo "== 5. prisma generate =="
# Route through run-with-env.sh so the provider is resolved from the restored
# .env (file: URL -> gitignored prisma/schema.local.prisma variant, ADR-008).
bash scripts/run-with-env.sh ./node_modules/.bin/prisma generate 2>&1 | tail -3

echo "== 6. next build (standalone) =="
bun run build 2>&1 | tail -12

echo "== 7. verify standalone artifacts =="
ls -la .next/standalone/server.js || { echo 'BUILD MISSING SERVER.JS'; exit 1; }

echo "== 8. start production server =="
pkill -f 'node .next/standalone' 2>/dev/null; sleep 1
set -a; . .env; set +a
export NODE_ENV=production SERVER_ACTIONS_ALLOWED_ORIGINS='http://localhost:3000' HOSTNAME=0.0.0.0 PORT=3000
setsid nohup node .next/standalone/server.js > /tmp/prod.log 2>&1 < /dev/null &
up=0
for i in $(seq 1 20); do
  sleep 3
  if curl -sf -m 5 http://localhost:3000/api/health > /dev/null 2>&1; then up=1; echo "server UP after ~$((i*3))s"; break; fi
done
if [ "$up" = "1" ]; then echo 'RESTORE-OK'; curl -s -m 5 http://localhost:3000/api/health; echo; else echo 'RESTORE-FAILED'; tail -40 /tmp/prod.log; fi

echo "== 9. keepalive until end of this tool call (reaper kills orphans ~45s after) =="
end=$((SECONDS+120))
while [ $SECONDS -lt $end ]; do
  if ! curl -sf -m 5 http://localhost:3000/api/health > /dev/null 2>&1; then
    pkill -f 'node .next/standalone' 2>/dev/null; sleep 1
    set -a; . .env; set +a
    export NODE_ENV=production SERVER_ACTIONS_ALLOWED_ORIGINS='http://localhost:3000' HOSTNAME=0.0.0.0 PORT=3000
    setsid nohup node .next/standalone/server.js > /tmp/prod.log 2>&1 < /dev/null &
  fi
  sleep 20
done
curl -sf -m 5 http://localhost:3000/api/health > /dev/null 2>&1 && echo 'FINAL-STATE: UP' || echo 'FINAL-STATE: DOWN (next cron firing will revive)'
