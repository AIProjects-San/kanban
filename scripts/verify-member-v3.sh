#!/bin/bash
# Test member visibility using avatar menu sign-out (just like real user)
set -e
BASE="http://localhost:3000"

echo "=== Step 1: Click avatar to open profile menu ==="
agent-browser open "$BASE/" > /dev/null
sleep 2
# Click the avatar button in topbar
agent-browser click 'button[aria-label="Account menu"]' 2>&1 | tail -2
sleep 1
echo "--- Profile menu contents ---"
agent-browser read 2>&1 | grep -i "sign out\|settings\|help" | head -5

echo ""
echo "=== Step 2: Click Sign out ==="
agent-browser click 'button:has-text("Sign out")' 2>&1 | tail -2
sleep 3
echo "--- After sign-out (should be login screen) ---"
agent-browser read 2>&1 | head -20

echo ""
echo "=== Step 3: Login as Member via demo account button ==="
# Click the Member demo account button (this fills email/password)
agent-browser click 'button:has-text("member@fernly.app")' 2>&1 | tail -2
sleep 1
# Now click Sign in
agent-browser click 'button:has-text("Sign in")' 2>&1 | tail -2
sleep 4

echo ""
echo "=== Step 4: Verify Member's dashboard ==="
agent-browser read 2>&1 | head -50

echo ""
echo "=== Step 5: Navigate to Tasks view ==="
agent-browser press 'g' > /dev/null 2>&1 || true
agent-browser press 't' > /dev/null 2>&1 || true
sleep 2
agent-browser read 2>&1 | head -50
