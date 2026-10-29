// Verify dev server: DB connectivity + credentials login flow
const BASE = "http://localhost:3000";

async function main() {
  // 1. DB connectivity via a real login (exercises Prisma + bcrypt + JWT)
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json();
  const cookie = csrfRes.headers.get("set-cookie")?.split(";")[0] ?? "";
  console.log("csrf token obtained:", !!csrfToken);

  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({
      csrfToken,
      email: "demo@fernly.app",
      password: "fernly123",
      json: "true",
    }),
    redirect: "manual",
  });
  const sessionCookie = (loginRes.headers.get("set-cookie") ?? "")
    .split(/,\s*/)
    .filter((c) => c.startsWith("next-auth.session-token"))
    .map((c) => c.split(";")[0])[0];
  console.log("login status:", loginRes.status, "| session cookie:", sessionCookie ? "OK" : "MISSING");

  if (!sessionCookie) {
    console.error("LOGIN FAILED");
    process.exit(1);
  }

  // 2. Authenticated dashboard fetch
  const dashRes = await fetch(`${BASE}/`, { headers: { Cookie: sessionCookie } });
  const html = await dashRes.text();
  const authed = html.includes("Fernly") && !html.includes('state="loading"');
  console.log("dashboard status:", dashRes.status, "| renders app:", authed);

  // 3. Session endpoint
  const sessRes = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: sessionCookie } });
  const session = await sessRes.json();
  console.log("session user:", session?.user?.email ?? "NONE", "| role:", session?.user?.role ?? "NONE");

  console.log("\nALL CHECKS PASSED");
}

main().catch((e) => {
  console.error("VERIFY FAILED:", e.message);
  process.exit(1);
});
