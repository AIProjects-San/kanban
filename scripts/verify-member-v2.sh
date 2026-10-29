#!/bin/bash
# Carefully test member visibility - sign out admin, sign in member, verify dashboard scope.
set -e
BASE="http://localhost:3000"

echo "=== Step 1: Sign out Admin via sidebar Logout button ==="
agent-browser open "$BASE/" > /dev/null
sleep 2
agent-browser click 'button:has-text("Logout")' 2>&1 | tail -3
sleep 3

echo "=== Step 2: Verify we're at login screen ==="
agent-browser read 2>&1 | grep -i "Welcome back\|Sign in\|Demo accounts" | head -5

echo ""
echo "=== Step 3: Fill member@fernly.app credentials ==="
agent-browser fill 'input[type="email"]' 'member@fernly.app' 2>&1 | tail -2
agent-browser fill 'input[type="password"]' 'fernly123' 2>&1 | tail -2
agent-browser click 'button:has-text("Sign in")' 2>&1 | tail -2
sleep 4

echo ""
echo "=== Step 4: Verify Member's dashboard greeting + KPI ==="
agent-browser read 2>&1 | head -45

echo ""
echo "=== Step 5: Navigate to Tasks and verify scope ==="
agent-browser press 'g' > /dev/null 2>&1 || true
agent-browser press 't' > /dev/null 2>&1 || true
sleep 2
agent-browser read 2>&1 | head -45
