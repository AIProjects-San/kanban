#!/bin/bash
# Verify all 4 new feature implementations end-to-end.
set -e

# Demo password lives in .env (NEXT_PUBLIC_DEMO_PASSWORD) — never in this repo.
DEMO_PASSWORD="${NEXT_PUBLIC_DEMO_PASSWORD:-$(grep -m1 '^NEXT_PUBLIC_DEMO_PASSWORD=' "$(dirname "$0")/../.env" 2>/dev/null | cut -d= -f2-)}"
if [[ -z "${DEMO_PASSWORD}" ]]; then
  echo "ERROR: NEXT_PUBLIC_DEMO_PASSWORD not set — add it to .env (see .env.example)." >&2
  exit 1
fi


BASE="http://localhost:3000"

echo "=========================================="
echo "TEST 1: Admin — Tasks page has project filter"
echo "=========================================="
agent-browser open "$BASE/" > /dev/null
sleep 2
# Sign in as Admin
agent-browser click 'button[data-email="demo@fernly.app"]' 2>/dev/null || \
  agent-browser click 'text=Demo as Admin' 2>/dev/null || true
sleep 1
agent-browser fill 'input[type="email"]' 'demo@fernly.app' 2>/dev/null || true
agent-browser fill 'input[type="password"]' "${DEMO_PASSWORD}" 2>/dev/null || true
agent-browser click 'button[type="submit"]' 2>/dev/null || true
sleep 3
# Navigate to Tasks via shortcut G T
agent-browser press 'g' 2>/dev/null || true
agent-browser press 't' 2>/dev/null || true
sleep 2
echo "--- Page text after navigating to Tasks ---"
agent-browser read 2>&1 | head -60
echo ""

echo "=========================================="
echo "TEST 2: Admin — Settings has Change Password section"
echo "=========================================="
agent-browser press 'g' 2>/dev/null || true
agent-browser press 's' 2>/dev/null || true
sleep 2
echo "--- Page text on Settings ---"
agent-browser read 2>&1 | head -80
echo ""
