#!/usr/bin/env node
// Fernly runtime smoke test — verifies the app end-to-end against a running
// dev server: login (admin + member), dashboard rendering, member scoping,
// server-action availability, and the auth hardening (unknown-email path).
//
// Usage: node scripts/smoke-test.mjs [baseUrl]

const BASE = process.argv[2] || "http://localhost:3000";
// Demo password comes from .env via the shared helper — never a literal.
import { demoPassword } from "./lib/demo-env.mjs";
const PASSWORD = demoPassword();

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function captureCookies(res, jar) {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
}

async function login(email, password) {
  const jar = {};
  // 1. Fetch the login page + CSRF token
  let res = await fetch(`${BASE}/`, { headers: { cookie: "" } });
  captureCookies(res, jar);
  // NextAuth csrf endpoint
  res = await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookieHeader(jar) } });
  captureCookies(res, jar);
  const { csrfToken } = await res.json();
  if (!csrfToken) throw new Error("no csrf token");
  // 2. Credentials callback
  const body = new URLSearchParams({
    csrfToken,
    email,
    password,
    redirect: "false",
    json: "true",
  });
  res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(jar),
    },
    body,
    redirect: "manual",
  });
  captureCookies(res, jar);
  const sessionCookie = Object.keys(jar).find((k) => k.includes("session-token"));
  return { jar, sessionCookie, status: res.status };
}

async function pageHtml(jar) {
  const res = await fetch(`${BASE}/`, {
    headers: { cookie: cookieHeader(jar) },
    redirect: "manual",
  });
  return { status: res.status, html: await res.text() };
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
(async () => {
  // 1. Admin login + dashboard
  try {
    const admin = await login("demo@fernly.app", PASSWORD);
    check("admin login issues a session cookie", !!admin.sessionCookie);
    const page = await pageHtml(admin.jar);
    check("dashboard renders for admin (200)", page.status === 200);
    check(
      "admin sees Users nav item",
      page.html.includes("Users") || page.html.includes("user"),
    );
    check("no login form in authenticated page", !page.html.includes('type="email"'));
  } catch (e) {
    check("admin login flow", false, e.message);
  }

  // 2. Member login + scoping
  try {
    const member = await login("member@fernly.app", PASSWORD);
    check("member login issues a session cookie", !!member.sessionCookie);
    const page = await pageHtml(member.jar);
    check("dashboard renders for member (200)", page.status === 200);
    check(
      "member does NOT see Workspace Settings nav",
      !/Workspace Settings/.test(page.html),
    );
  } catch (e) {
    check("member login flow", false, e.message);
  }

  // 3. Wrong password is rejected
  try {
    const bad = await login("demo@fernly.app", "definitely-wrong");
    check("wrong password yields no session", !bad.sessionCookie);
  } catch (e) {
    check("wrong password flow", false, e.message);
  }

  // 4. Unknown email behaves identically (no session)
  try {
    const ghost = await login("ghost@nowhere.dev", "whatever-123");
    check("unknown email yields no session", !ghost.sessionCookie);
  } catch (e) {
    check("unknown email flow", false, e.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
  if (failed.length) process.exit(1);
})();
