// PR-37 (production-readiness round 2, roadmap §6.9) — production-build
// smoke suite.
//
// The e2e suite runs against the DEV server; the production standalone
// build was only exercised by the load smoke. This script boots the REAL
// production build (.next/standalone/server.js) on a scratch port and runs
// a battery of functional checks against it — closing the "e2e only tests
// dev" gap without duplicating the 53-scenario browser suite:
//
//   1. server boots and /api/health turns 200 (DB wired)
//   2. GET / renders the login page (SSR HTML intact, email input present)
//   3. security headers ship in the production build (HSTS, XFO, CSP+nonce)
//   4. bad credentials are REJECTED (401, no session cookie)
//   5. full credential login succeeds (Better Auth /sign-in/email + bcrypt
//      + DB + session mint; fernly.session_token posture checked)
//   6. the session cookie renders the authenticated shell, resolves the
//      user on get-session, and sign-out expires it
//   7. /api/health?detail=1 honours the CRON_SECRET gate
//   8. /api/metrics refuses anonymous callers and serves Prometheus text
//      to authorized ones (or reports 503-disabled when CRON_SECRET unset)
//
// Usage:  bun run test:prodsmoke          (build first: bun run build)
// Env:    SMOKE_PORT (default 3111), SMOKE_EMAIL/SMOKE_PASSWORD override
//         the login account (defaults: demo@fernly.app / $NEXT_PUBLIC_DEMO_PASSWORD).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const STANDALONE = resolve(PROJECT_ROOT, ".next/standalone/server.js");
const ENV_FILE = resolve(PROJECT_ROOT, ".env");

// ---------------------------------------------------------------------------
// .env parsing (same keys the app itself reads; values unquoted if quoted).
// ---------------------------------------------------------------------------

function parseEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const fileEnv = parseEnvFile(ENV_FILE);
const EMAIL = process.env.SMOKE_EMAIL || "demo@fernly.app";
const PASSWORD = process.env.SMOKE_PASSWORD || fileEnv.NEXT_PUBLIC_DEMO_PASSWORD;
const CRON_SECRET = process.env.CRON_SECRET || fileEnv.CRON_SECRET || "";
if (!PASSWORD) {
  // Secret hygiene (scripts/lib/demo-env.mjs, docs/SECURITY.md): the demo
  // password's only home is .env (NEXT_PUBLIC_DEMO_PASSWORD) — there is no
  // hardcoded fallback. Fail fast instead of minting doomed logins.
  console.error(
    "prod-smoke: no demo password available — set NEXT_PUBLIC_DEMO_PASSWORD in .env\n" +
      "  (the demo password's only home) or export SMOKE_PASSWORD to override the\n" +
      "  login account's password.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Check runner.
// ---------------------------------------------------------------------------

const checks = [];
let failed = 0;

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

/** Better Auth credential login (/api/auth-better/sign-in/email),
 * cookie-jar by hand. Returns the response + the fernly.session_token
 * Set-Cookie (if any). */
async function fullLogin(email, password) {
  const res = await fetch(`${BASE}/api/auth-better/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  await res.arrayBuffer();
  const setCookies = res.headers.getSetCookie() ?? [];
  const sessionCookie = setCookies.find((c) =>
    /fernly\.session_token=/.test(c.split(";")[0]),
  );
  return { res, sessionCookie };
}

// ---------------------------------------------------------------------------
// Boot the production server.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// R-P0-6 — step 0: production bundle hygiene (REVIEW_TRIAGE §4.5-6).
//
// The build gate in next.config.ts FAILS a production build that sets
// NEXT_PUBLIC_DEMO_PASSWORD without the explicit sandbox hatch; this grep
// verifies the built OUTPUT independently of the gate (defense in depth —
// it would also catch a future build path that bypasses config evaluation).
//
// The check asserts the demo password VALUE is absent from the build
// output (.next/cache excluded — stale chunks from an older demo build
// are not shipped output) UNLESS the build explicitly opted in with
// ALLOW_DEMO_CREDENTIALS_IN_BUILD=1 (the sandbox demo preview — the one
// documented exception).
//
// Empirical note (build inspection, R-P0-6): in a build WITHOUT the value
// set, the login chunk still carries the variable NAME as a dead runtime
// read (`process.env.NEXT_PUBLIC_DEMO_PASSWORD ?? ""` compiles to a
// node-process shim access that is always undefined in the browser — the
// pre-existing L-P0-12 shape). A blanket name grep therefore false-
// positives every clean build; the VALUE is the credential, and the value
// is what this check pins.
// ---------------------------------------------------------------------------
function grepIn(haystackDir, needle) {
  try {
    const out = execFileSync(
      "grep",
      ["-rl", "--binary-files=text", "--exclude-dir=cache", needle, haystackDir],
      { encoding: "utf8", timeout: 60_000 },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch (err) {
    // grep exit 1 = no matches (the good case); anything else rethrows.
    if (err && typeof err === "object" && "status" in err && err.status === 1) return [];
    throw err;
  }
}

if (!existsSync(STANDALONE)) {
  console.error(
    "prod-smoke: .next/standalone/server.js not found — run `bun run build` first.",
  );
  process.exit(2);
}

{
  const demoPw =
    process.env.NEXT_PUBLIC_DEMO_PASSWORD || fileEnv.NEXT_PUBLIC_DEMO_PASSWORD;
  const hatch =
    process.env.ALLOW_DEMO_CREDENTIALS_IN_BUILD === "1" ||
    fileEnv.ALLOW_DEMO_CREDENTIALS_IN_BUILD === "1";
  if (demoPw && !hatch) {
    const valueHits = grepIn(resolve(PROJECT_ROOT, ".next"), demoPw);
    if (valueHits.length > 0) {
      console.error(
        `prod-smoke: FAIL — the demo password VALUE is in the build output (${valueHits.slice(0, 3).join(", ")}) without ALLOW_DEMO_CREDENTIALS_IN_BUILD=1. This build must not ship.`,
      );
      process.exit(2);
    }
  }
  console.log(
    "prod-smoke: bundle hygiene OK — " +
      (demoPw && hatch
        ? "demo VALUE present under the explicit sandbox hatch (the demo preview build)"
        : "no demo password value in the build output"),
  );
}

console.log(`prod-smoke: booting the production build on ${BASE} …`);
const child = spawn(process.execPath, [STANDALONE], {
  env: {
    ...fileEnv,
    ...process.env,
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    // The app's boot contract requires a secret; .env normally has one.
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || fileEnv.BETTER_AUTH_SECRET,
    // R-P0-6 — the production default trusts same-origin only; the smoke
    // server is reached on 127.0.0.1:PORT, so list it EXPLICITLY (this also
    // exercises the "specific list → no warning" startup path).
    SERVER_ACTIONS_ALLOWED_ORIGINS:
      process.env.SERVER_ACTIONS_ALLOWED_ORIGINS ||
      `http://127.0.0.1:${PORT},http://localhost:${PORT}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => {
  serverLog += d;
});
child.stderr.on("data", (d) => {
  serverLog += d;
});

try {
  if (!(await waitForHealth(60_000))) {
    console.error("prod-smoke: server never became healthy. Server log tail:");
    console.error(serverLog.slice(-4000));
    process.exit(1);
  }
  console.log("prod-smoke: server healthy — running checks\n");

  // 1–2: the login page renders server-side.
  const homeRes = await fetch(`${BASE}/`, { redirect: "manual" });
  const homeHtml = await homeRes.text();
  check("GET / returns 200", homeRes.status === 200, `status ${homeRes.status}`);
  check(
    "login page renders (email input present in SSR HTML)",
    /type="email"/i.test(homeHtml),
  );

  // 3: security headers made it into the production build.
  const hsts = homeRes.headers.get("strict-transport-security") ?? "";
  const xfo = homeRes.headers.get("x-frame-options") ?? "";
  const csp = homeRes.headers.get("content-security-policy") ?? "";
  check("HSTS header present (max-age 1y)", /^max-age=31536000/.test(hsts), hsts);
  check("X-Frame-Options DENY", xfo === "DENY", xfo);
  check(
    "CSP present and nonce-based (proxy ran in prod)",
    csp.includes("nonce-") && !csp.includes("unsafe-eval"),
  );

  // PR-40 — style-src is hardened to 'self' (no unsafe-inline), and the SSR
  // HTML proves it is safe: zero inline <style> elements and zero style=
  // attributes outside <script> payloads on both the login page and the
  // authenticated shell. Client-side dynamic styling goes through the CSSOM,
  // which CSP never blocks.
  const styleSrc = csp.match(/style-src[^;]*/)?.[0] ?? "";
  check(
    "CSP style-src has no unsafe-inline (PR-40)",
    /^style-src 'self'$/.test(styleSrc),
    styleSrc,
  );
  const stripScripts = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "");
  const inlineStyleViolations = (html) => {
    const bare = stripScripts(html);
    const tags = bare.match(/<style[\s>]/gi) ?? [];
    const attrs = bare.match(/\sstyle="/g) ?? [];
    return tags.length + attrs.length;
  };
  check(
    "login SSR HTML: no inline <style> elements, no style= attributes (PR-40)",
    inlineStyleViolations(homeHtml) === 0,
    `${inlineStyleViolations(homeHtml)} violation(s)`,
  );

  // 4: bad credentials are rejected without minting a session.
  const bad = await fullLogin(EMAIL, "definitely-wrong-password");
  check(
    "bad credentials rejected (401, no session cookie)",
    bad.res.status === 401 && !bad.sessionCookie,
    `status ${bad.res.status}`,
  );

  // 5: real credentials mint a session.
  const good = await fullLogin(EMAIL, PASSWORD);
  check(
    "credential login succeeds (200 + fernly.session_token cookie)",
    good.res.status === 200 && !!good.sessionCookie,
    `status ${good.res.status}`,
  );
  if (good.sessionCookie) {
    check(
      "session cookie posture (httpOnly, SameSite=Lax)",
      /httponly/i.test(good.sessionCookie) && /samesite=lax/i.test(good.sessionCookie),
      good.sessionCookie.split(";").slice(1).join(";").trim(),
    );
  }

  // 6: the session cookie renders the authenticated shell, resolves the
  // user on get-session, and sign-out expires it (the full credential
  // contract on the Better Auth stack — the only stack since PR-49).
  if (good.sessionCookie) {
    const authed = await fetch(`${BASE}/`, {
      headers: { cookie: good.sessionCookie.split(";")[0] },
      redirect: "manual",
    });
    const authedHtml = await authed.text();
    check(
      "session cookie renders the app shell (no login form)",
      authed.status === 200 && !/type="email"/i.test(authedHtml),
      `status ${authed.status}`,
    );
    check(
      "authed SSR HTML: no inline <style> elements, no style= attributes (PR-40)",
      inlineStyleViolations(authedHtml) === 0,
      `${inlineStyleViolations(authedHtml)} violation(s)`,
    );

    const sessionRes = await fetch(`${BASE}/api/auth-better/get-session`, {
      headers: { cookie: good.sessionCookie.split(";")[0] },
    });
    const sessionBody = await sessionRes.json().catch(() => null);
    check(
      "session cookie resolves the user on get-session",
      sessionRes.status === 200 && sessionBody?.user?.email === EMAIL,
      `status ${sessionRes.status}`,
    );

    const outRes = await fetch(`${BASE}/api/auth-better/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        cookie: good.sessionCookie.split(";")[0],
      },
      body: "{}",
    });
    const outCookies = outRes.headers.getSetCookie() ?? [];
    check(
      "sign-out expires the session cookie",
      outRes.status === 200 &&
        outCookies.some(
          (c) =>
            /fernly\.session_token=;/.test(c.split(";")[0] + ";") ||
            (/fernly\.session_token=/.test(c) && /Max-Age=0/i.test(c)),
        ),
      `status ${outRes.status}`,
    );
  }

  // 7: health detail honours the CRON_SECRET gate.
  const detailRes = await fetch(`${BASE}/api/health?detail=1`, {
    headers: { authorization: `Bearer ${CRON_SECRET || "none"}` },
  });
  const detailBody = await detailRes.json().catch(() => ({}));
  if (CRON_SECRET) {
    check(
      "/api/health?detail=1 authorized shows db/redis detail",
      detailRes.status === 200 && detailBody.db !== undefined,
      `status ${detailRes.status}`,
    );
  } else {
    check(
      "/api/health?detail=1 without CRON_SECRET hides detail",
      detailRes.status === 200 && detailBody.db === undefined,
    );
  }

  // 8: the metrics endpoint (PR-32).
  const anonMetrics = await fetch(`${BASE}/api/metrics`);
  if (CRON_SECRET && CRON_SECRET.length >= 16) {
    const authedMetrics = await fetch(`${BASE}/api/metrics`, {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    const metricsText = await authedMetrics.text();
    check(
      "/api/metrics refuses anonymous callers (401)",
      anonMetrics.status === 401,
      `status ${anonMetrics.status}`,
    );
    check(
      "/api/metrics serves Prometheus text to authorized callers",
      authedMetrics.status === 200 &&
        authedMetrics.headers.get("content-type").includes("text/plain") &&
        metricsText.includes("fernly_app_up"),
    );
  } else {
    check(
      "/api/metrics is visibly disabled without CRON_SECRET (503)",
      anonMetrics.status === 503,
      `status ${anonMetrics.status}`,
    );
  }
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      r();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(t);
      r();
    });
  });
}

console.log(
  `\nprod-smoke: ${checks.length - failed}/${checks.length} checks passed` +
    (failed ? ` (${failed} FAILED)` : ""),
);
if (failed) {
  console.error("\nServer log tail for debugging:");
  console.error(serverLog.slice(-3000));
}
process.exit(failed ? 1 : 0);
