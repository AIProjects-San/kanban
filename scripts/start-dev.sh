#!/bin/bash
# Start the Next.js dev server in a fully detached process
cd /home/z/my-project

# Kill any existing dev server
pkill -f "next dev" 2>/dev/null || true
sleep 1

# Explicitly export env vars from .env so Prisma can read them at runtime
export $(grep -v '^#' .env | xargs)

# Start dev server with full detachment
nohup bun run dev > /home/z/my-project/dev.log 2>&1 &
DEV_PID=$!
disown $DEV_PID 2>/dev/null || true

echo "Dev server started with PID: $DEV_PID"

# Wait for it to be ready
for i in $(seq 1 30); do
  if curl -s http://localhost:3000 -o /dev/null 2>/dev/null; then
    echo "Dev server is ready (took ${i}s)"
    exit 0
  fi
  sleep 1
done

echo "Dev server failed to start"
exit 1
