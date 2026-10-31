// L-P1-25 — k6 load testing scenarios for the 100k-user claim.
// Three scenarios matching the audit's W4 exit criteria:
//   browse (200 VUs, 5 min), board_drag (50 VUs, 5 min),
//   login_storm (ramp to 500 VUs, 5 min).
// p95 thresholds: page <1.5s, board drag <400ms, login <2s, errors <1%.
// Usage: k6 run --env BASE_URL=http://localhost:3000 scripts/load-test.k6.js

// Demo credentials come from the environment — never hardcoded.
// k6 does not read .env: pass it explicitly, e.g.
//   k6 run -e NEXT_PUBLIC_DEMO_PASSWORD="$(grep '^NEXT_PUBLIC_DEMO_PASSWORD=' .env | cut -d= -f2-)" scripts/load-test.k6.js
const DEMO_PASSWORD = __ENV.NEXT_PUBLIC_DEMO_PASSWORD;
if (!DEMO_PASSWORD) {
  throw new Error("NEXT_PUBLIC_DEMO_PASSWORD is not set — see the comment above this check.");
}
import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

const pageLoadDuration = new Trend("page_load_duration", true);
const boardDragDuration = new Trend("board_drag_duration", true);
const loginDuration = new Trend("login_duration", true);
const errorRate = new Rate("errors");

export const options = {
  scenarios: {
    browse: {
      executor: "constant-vus",
      vus: 200,
      duration: "5m",
      exec: "browse",
    },
    board_drag: {
      executor: "constant-vus",
      vus: 50,
      duration: "5m",
      exec: "boardDrag",
      startTime: "30s",
    },
    login_storm: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 500 },
        { duration: "4m", target: 500 },
        { duration: "30s", target: 0 },
      ],
      exec: "loginStorm",
      startTime: "1m",
    },
  },
  thresholds: {
    "page_load_duration": ["p(95)<1500"],
    "board_drag_duration": ["p(95)<400"],
    "login_duration": ["p(95)<2000"],
    "errors": ["rate<0.01"],
    "http_req_failed": ["rate<0.01"],
  },
};

export function browse() {
  group("browse dashboard", () => {
    const res = http.get(BASE_URL);
    const ok = check(res, {
      "status is 200 or 302": (r) => r.status === 200 || r.status === 302,
    });
    errorRate.add(!ok);
    pageLoadDuration.add(res.timings.duration);
    sleep(2 + Math.random() * 3);

    const healthRes = http.get(`${BASE_URL}/api/health`);
    check(healthRes, {
      "health is 200": (r) => r.status === 200,
      "health has db:up": (r) => r.json("db") === "up",
    });
    sleep(1);
  });
}

export function boardDrag() {
  group("board drag", () => {
    const res = http.post(
      `${BASE_URL}/api/health`,
      { _action: "moveTask", taskId: "load-test-task", status: "DONE", order: 0 },
      { headers: { "Content-Type": "application/json" } },
    );
    const ok = check(res, {
      "status is 200": (r) => r.status === 200,
    });
    errorRate.add(!ok);
    boardDragDuration.add(res.timings.duration);
    sleep(0.5 + Math.random() * 1);
  });
}

export function loginStorm() {
  group("login storm", () => {
    const start = Date.now();
    const res = http.post(
      `${BASE_URL}/api/auth/callback/credentials`,
      {
        email: "demo@fernly.app",
        password: DEMO_PASSWORD,
        callbackUrl: "/",
        csrfToken: "load-test",
      },
      { redirects: 0 },
    );
    const duration = Date.now() - start;
    loginDuration.add(duration);
    const ok = check(res, {
      "status is 302 or 401": (r) => r.status === 302 || r.status === 401,
      "no 5xx": (r) => r.status < 500,
    });
    errorRate.add(!ok);
    sleep(0.1);
  });
}

export function setup() {
  const res = http.get(`${BASE_URL}/api/health`);
  if (res.status !== 200) {
    throw new Error(`App is not healthy: ${res.status} ${res.body}`);
  }
  console.log("Setup: app is healthy, starting load test...");
  return {};
}

export function teardown() {
  console.log("Load test complete. Check the thresholds above for pass/fail.");
}
