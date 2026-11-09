#!/usr/bin/env bash
# Local e2e runner — mirrors the CI e2e job against the sandbox dev preview.
#
# CI runs the suite on ubuntu runners with a system Chrome + Selenium Manager.
# The sandbox has no system Chrome, so we point selenium-webdriver at a
# standalone chromedriver (Chrome-for-Testing unpacked into .chrome-e2e/):
#   SELENIUM_REMOTE_URL → the standalone driver
#   CHROME_BIN           → the Chrome-for-Testing binary (options.binary)
#
# Usage:
#   bash scripts/start-dev-persistent.sh        # dev server on :3000
#   ./.chrome-e2e/chromedriver-linux64/chromedriver --port=9515 &
#   bash scripts/e2e-local.sh
set -u
cd "$(dirname "$0")/.."
export SELENIUM_REMOTE_URL="${SELENIUM_REMOTE_URL:-http://localhost:9515}"
export CHROME_BIN="${CHROME_BIN:-$(pwd)/.chrome-e2e/chrome-linux64/chrome}"
export SELENIUM_HEADLESS="${SELENIUM_HEADLESS:-1}"
export BASE_URL="${BASE_URL:-http://localhost:3000}"
exec bun run test:e2e
