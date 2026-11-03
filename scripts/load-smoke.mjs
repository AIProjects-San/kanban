// PR-29 — Bun-based smoke load test (no k6 dependency in the sandbox).
//
// Runs against the PRODUCTION standalone build (start it first):
//   PORT=3100 bash scripts/run-with-env.sh bun .next/standalone/server.js &
//   bun scripts/load-smoke.mjs http://localhost:3100 60
//
// Scenarios (mix approximates real traffic):
//   • browse  — 35 concurrent GETs of / (SSR login/dashboard shell, the heaviest page)
//   • health  — 5 concurrent GETs of /api/health (LB probe traffic)
//   • login   — 8 concurrent FULL credential logins (csrf fetch + POST callback
//               → exercises bcrypt cost-12 + DB + session mint; the expensive path)
//
// Reports p50/p95/p99, RPS and error rate per scenario. This is a SMOKE test —
// it catches collapse points and gross regressions on this 2-core sandbox; the
// k6 scenarios in scripts/load-test.k6.js remain the reference for real
// capacity planning on production hardware.

const BASE = process.argv[2] || "http://localhost:3100";
const DURATION_S = Number(process.argv[3] || 60);
// Worker counts are tunable so the same script covers a normal-traffic
// profile (LOGIN_VUS=2) and a login-storm profile (LOGIN_VUS=8).
const LOGIN_VUS = Number(process.env.LOGIN_VUS || 8);
const PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD || "fernly123";

const results = {
  browse: { latencies: [], errors: 0 },
  health: { latencies: [], errors: 0 },
  login: { latencies: [], errors: 0 },
};

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

async function timedFetch(url, opts) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, opts);
    // Drain the body so the timing includes the full transfer.
    await res.arrayBuffer();
    const ms = performance.now() - t0;
    return { ok: res.ok, status: res.status, ms };
  } catch (err) {
    return { ok: false, status: 0, ms: performance.now() - t0, err: String(err) };
  }
}

async function browseWorker(stopAt) {
  while (Date.now() < stopAt) {
    const r = await timedFetch(`${BASE}/`, { redirect: "manual" });
    results.browse.latencies.push(r.ms);
    if (!r.ok) results.browse.errors++;
    await Bun.sleep(250 + Math.random() * 500); // human-ish pacing
  }
}

async function healthWorker(stopAt) {
  while (Date.now() < stopAt) {
    const r = await timedFetch(`${BASE}/api/health`);
    results.health.latencies.push(r.ms);
    if (!r.ok) results.health.errors++;
    await Bun.sleep(2000); // probe cadence
  }
}

async function loginWorker(stopAt) {
  let i = 0;
  while (Date.now() < stopAt) {
    i++;
    const email = i % 2 === 0 ? "manager@fernly.app" : "member@fernly.app";
    const t0 = performance.now();
    try {
      // 1. CSRF token (+ its cookie — Bun fetch has no cookie jar, so the
      //    set-cookies are carried forward manually like a browser would).
      const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
      const { csrfToken } = await csrfRes.json();
      const setCookies = csrfRes.headers.getSetCookie?.() ?? [];
      const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");
      // 2. Credentials callback (bcrypt + DB + session mint)
      const body = new URLSearchParams({ csrfToken, email, password: PASSWORD });
      const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        body,
        redirect: "manual",
      });
      await loginRes.arrayBuffer();
      const ms = performance.now() - t0;
      results.login.latencies.push(ms);
      // Success = 302 to the app. A redirect into /api/auth/signin or an
      // error= param is a FAILED login (CSRF mismatch, bad credentials, or
      // the 5/15min per-IP throttle — reported, not silently counted OK).
      const loc = loginRes.headers.get("location") ?? "";
      const failed =
        loginRes.status !== 302 || /csrf=true|error=|signin/i.test(loc);
      if (failed) results.login.errors++;
    } catch {
      results.login.latencies.push(performance.now() - t0);
      results.login.errors++;
    }
    await Bun.sleep(1200 + Math.random() * 800);
  }
}

const t0 = Date.now();
const stopAt = t0 + DURATION_S * 1000;
const workers = [
  ...Array.from({ length: 35 }, () => browseWorker(stopAt)),
  ...Array.from({ length: 5 }, () => healthWorker(stopAt)),
  ...Array.from({ length: LOGIN_VUS }, () => loginWorker(stopAt)),
];
await Promise.all(workers);
const wall = (Date.now() - t0) / 1000;

console.log(`\n=== Smoke load results (${BASE}, ${wall.toFixed(1)}s wall) ===`);
console.log("scenario   n      rps     p50      p95      p99      errors");
for (const [name, r] of Object.entries(results)) {
  const n = r.latencies.length;
  const rps = (n / wall).toFixed(1);
  const line = [
    name.padEnd(10),
    String(n).padEnd(6),
    rps.padEnd(7),
    fmt(pct(r.latencies, 50)).padEnd(8),
    fmt(pct(r.latencies, 95)).padEnd(8),
    fmt(pct(r.latencies, 99)).padEnd(8),
    `${r.errors} (${n ? ((r.errors / n) * 100).toFixed(1) : "0"}%)`,
  ].join(" ");
  console.log(line);
}
const total = Object.values(results).reduce((s, r) => s + r.latencies.length, 0);
const totalErr = Object.values(results).reduce((s, r) => s + r.errors, 0);
console.log(`\ntotal: ${total} requests, ${(total / wall).toFixed(1)} rps overall, ${totalErr} errors (${((totalErr / total) * 100).toFixed(2)}%)`);
