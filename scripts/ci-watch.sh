#!/usr/bin/env bash
# Poll the GitHub Actions run for a given commit SHA until it completes.
# Prints one status line per poll; exits 0 when the run is completed.
# Usage: GITHUB_TOKEN=<token> bash scripts/ci-watch.sh <full-sha> [max-seconds]
set -u
SHA="${1:?sha required}"
MAXS="${2:-560}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN required}"
REPO="AIProjects-San/kanban"
deadline=$(( $(date +%s) + MAXS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  out=$(curl -s -H "Authorization: token $TOKEN" \
    "https://api.github.com/repos/$REPO/actions/runs?head_sha=$SHA&per_page=10")
  line=$(printf '%s' "$out" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR"); raise SystemExit
rs = d.get("workflow_runs") or []
if not rs:
    print("NO_RUN_YET"); raise SystemExit
r = rs[0]
print(r["status"] + "|" + str(r["conclusion"]) + "|" + str(r["id"]))
' 2>/dev/null || echo "CURL_ERROR")
  echo "$(date +%H:%M:%S) $line"
  case "$line" in
    completed*) exit 0 ;;
  esac
  sleep 30
done
echo "TIMEOUT"
exit 2
