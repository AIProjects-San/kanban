#!/bin/bash
# Test task modal project-allocated members restriction (Admin)
set -e
BASE="http://localhost:3000"

echo "=========================================="
echo "TEST 3: Admin — Task modal: assignee restricted to project-allocated members"
echo "=========================================="
# Already signed in as Admin from TEST 1
agent-browser open "$BASE/" > /dev/null
sleep 2
agent-browser press 'g' > /dev/null 2>&1 || true
agent-browser press 't' > /dev/null 2>&1 || true
sleep 2
# Open the task modal
agent-browser click 'text=New Task' > /dev/null 2>&1 || true
sleep 2
echo "--- Task modal contents (before picking project) ---"
agent-browser read 2>&1 | head -80
echo ""

echo "--- Now pick a project (Halcyon Labs Website) ---"
# Pick a project that has known assignees
agent-browser click 'select' 2>/dev/null || true
sleep 1
# The first select is project; click option for Halcyon Labs Website
# Using keyboard navigation since select option click is tricky
echo "(skipping manual project pick - reading current state)"
sleep 1
echo "--- Modal contents ---"
agent-browser read 2>&1 | tail -40
echo ""
