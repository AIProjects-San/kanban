#!/bin/bash
# Test member visibility end-to-end via browser
set -e

# Demo password lives in .env (NEXT_PUBLIC_DEMO_PASSWORD) — never in this repo.
DEMO_PASSWORD="${NEXT_PUBLIC_DEMO_PASSWORD:-$(grep -m1 '^NEXT_PUBLIC_DEMO_PASSWORD=' "$(dirname "$0")/../.env" 2>/dev/null | cut -d= -f2-)}"
if [[ -z "${DEMO_PASSWORD}" ]]; then
  echo "ERROR: NEXT_PUBLIC_DEMO_PASSWORD not set — add it to .env (see .env.example)." >&2
  exit 1
fi

BASE="http://localhost:3000"

echo "=========================================="
echo "TEST 4: Member login — restricted dashboard + tasks"
echo "=========================================="
agent-browser open "$BASE/" > /dev/null
sleep 2
# Sign out first if signed in
agent-browser click 'text=Logout' 2>/dev/null || true
sleep 2
# Sign in as Member
agent-browser fill 'input[type="email"]' 'member@fernly.app' 2>/dev/null || true
agent-browser fill 'input[type="password"]' "${DEMO_PASSWORD}" 2>/dev/null || true
agent-browser click 'button[type="submit"]' 2>/dev/null || true
sleep 3

echo "--- Dashboard after Member login ---"
agent-browser read 2>&1 | head -50
echo ""

echo "=========================================="
echo "TEST 5: Member — Tasks page (should be scoped)"
echo "=========================================="
agent-browser press 'g' > /dev/null 2>&1 || true
agent-browser press 't' > /dev/null 2>&1 || true
sleep 2
echo "--- Tasks view for Member ---"
agent-browser read 2>&1 | head -60
echo ""
