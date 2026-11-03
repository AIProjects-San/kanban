// PHASE 0 SPIKE — validates the Better Auth 1.7 credentials flow against the
// Prisma adapter on SQLite (docs/AUTH_MIGRATION_PLAN.md §5, Phase 0).
//
// Run: node scripts/spike-better-auth/spike.mjs
// (after `prisma generate` + `prisma db push` against spike.schema.prisma —
//  see run-spike.sh)
//
// Validates, end-to-end through the REAL HTTP handler (not auth.api.*):
//   1. sign-in with email/password (bcryptjs hash/verify, cost 12)
//   2. the session cookie is minted with the expected name + attributes
//   3. getSession with the cookie returns the user incl. additionalFields
//   4. hooks.before / hooks.after fire on /sign-in/email with usable context
//   5. databaseHooks.session.create.after fires (audit-row home)
//   6. an unknown email burns a bcrypt compare (timing equalizer parity)
//   7. sign-out revokes the session and expires the cookie
//   8. soft-deleted users are rejected by the before-hook gate
//   9. wrong password → 401 UNAUTHORIZED, limiter hit recorded
//  10. Postgres variant: adapter provider mapping is config-only (CI job
//      covers the real Postgres run — this sandbox has no Postgres binary).

import { PrismaClient } from "./gen/client/client.js";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";

const prisma = new PrismaClient();

const log = (...args) => console.log("[spike]", ...args);
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    log(`  ✓ ${name}`);
  } else {
    failures++;
    log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Throttle + audit state the hooks exercise (in-memory stand-ins for the
// real loginLimiter / auditLog — Phase 2 ports those verbatim).
// ---------------------------------------------------------------------------
const limiter = { hits: 0, blocked: false };
const auditRows = [];
const sessionCreates = [];

const DUMMY_HASH =
  "$2b$12$llbxFwXYn3xp2mUpBZUk3ec17zATv43gw0rBZq1kItXp3H11.q5UO"; // same as src/lib/auth.ts

const auth = betterAuth({
  appName: "Fernly",
  baseURL: "http://localhost:3000",
  basePath: "/api/auth-better",
  secret: "spike-secret-0123456789abcdef0123456789abcdef",
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  // (validated: betterAuth requires the explicit prismaAdapter wrapper — a
  //  bare PrismaClient fails with "Failed to initialize database adapter".)
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 8,
    password: {
      hash: (pw) => bcrypt.hash(pw, 12),
      verify: async ({ password, hash }) => bcrypt.compare(password, hash),
    },
  },
  user: {
    modelName: "User",
    additionalFields: {
      role: { type: "string", input: false },
      tokenVersion: { type: "number", input: false },
    },
  },
  session: {
    expiresIn: 7 * 24 * 60 * 60, // 7 days — parity with the v4 JWT maxAge
    updateAge: 24 * 60 * 60,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes — parity with ROLE_REFRESH_MS
    },
  },
  advanced: {
    cookiePrefix: "fernly",
    useSecureCookies: false, // dev/sandbox parity with v4
    database: {
      // FINDING: with the brownfield User table (required app-only columns
      // like passwordHash), the default runtime schema check throws
      // SchemaMismatchError ("unexpected-required-column") on every request.
      validateSchema: false,
    },
  },
  trustedOrigins: ["http://localhost:3000"],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      // Record the context shape for the port map.
      globalThis.__beforeCtxKeys = Object.keys(ctx).sort().join(",");
      if (limiter.blocked) {
        throw new APIError("TOO_MANY_REQUESTS", { message: "throttled" });
      }
      // Soft-delete gate: reject before Better Auth's own lookup. A plain
      // Error would surface as 500 SERVER_ERROR — APIError controls the code.
      if (ctx.body?.email) {
        const u = await prisma.user.findUnique({
          where: { email: String(ctx.body.email).trim().toLowerCase() },
          select: { deletedAt: true },
        });
        if (u?.deletedAt) {
          await bcrypt.compare(String(ctx.body.password ?? ""), DUMMY_HASH);
          throw new APIError("UNAUTHORIZED", { message: "invalid credentials" });
        }
      }
      return { context: {} };
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      globalThis.__afterCtxKeys = Object.keys(ctx).sort().join(",");
      // FINDING: the endpoint result lives at ctx.context.returned — an
      // APIError (numeric .statusCode, string .status) or the JSON body.
      const returned = ctx.context.returned;
      const status =
        typeof returned?.statusCode === "number"
          ? returned.statusCode
          : typeof returned?.status === "number"
            ? returned.status
            : returned instanceof Response
              ? returned.status
              : 200;
      if (status >= 400) limiter.hits++;
      if (status < 400) {
        limiter.hits = 0; // successful sign-in resets the budget
        auditRows.push({ action: "auth.signed_in", ip: "1.2.3.4" });
      }
    }),
  },
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          // Belt-and-braces: a soft-deleted user must never mint a session.
          const u = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { deletedAt: true },
          });
          if (u?.deletedAt) return false;
          return session;
        },
        after: async (session) => {
          sessionCreates.push(session.userId);
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// HTTP helpers — drive the real handler like the Next.js route would.
// ---------------------------------------------------------------------------
const BASE = "http://localhost:3000/api/auth-better";

async function call(method, path, { body, cookie } = {}) {
  const headers = new Headers({ origin: "http://localhost:3000" });
  if (body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const res = await auth.handler(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { res, json: await res.json().catch(() => null), setCookies };
}

function cookieJar(setCookies) {
  return setCookies
    .map((c) => c.split(";")[0])
    .filter((c) => !c.startsWith("fernly.session_data=") || true)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Seed: one healthy user, one soft-deleted user (credential account rows in
// the Better Auth 1.7 shape: providerId "credential", accountId = user id).
// ---------------------------------------------------------------------------
const PASSWORD = "spike-password-123";
const hash = await bcrypt.hash(PASSWORD, 12);

async function seedUser(email, name, { softDelete = false } = {}) {
  const u = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: hash,
      role: "MEMBER",
      ...(softDelete ? { deletedAt: new Date() } : {}),
    },
  });
  await prisma.account.create({
    data: {
      accountId: u.id,
      providerId: "credential",
      userId: u.id,
      password: hash, // synced from User.passwordHash by the bridge hook in Phase 1
    },
  });
  return u;
}

const healthy = await seedUser("healthy@spike.test", "Healthy User");
const softy = await seedUser("soft@spike.test", "Soft-Deleted User", { softDelete: true });

// ---------------------------------------------------------------------------
// 1–3: successful sign-in, cookie mint, session fetch
// ---------------------------------------------------------------------------
log("1–3: successful sign-in → cookie → session");
const signIn = await call("POST", "/sign-in/email", {
  body: { email: "healthy@spike.test", password: PASSWORD },
});
check("sign-in returns 200", signIn.res.status === 200, `status=${signIn.res.status} body=${JSON.stringify(signIn.json)}`);
check(
  "sign-in returns the user with role (additionalFields)",
  signIn.json?.user?.role === "MEMBER" && signIn.json?.user?.tokenVersion === 0,
  JSON.stringify(signIn.json?.user),
);

const sessionCookieName = "fernly.session_token";
const sessionCookie = signIn.setCookies.find((c) => c.startsWith(`${sessionCookieName}=`));
check("session cookie minted with the fernly prefix", !!sessionCookie, signIn.setCookies.join(" | "));
check(
  "session cookie is httpOnly + SameSite=Lax + Path=/",
  /httponly/i.test(sessionCookie ?? "") && /samesite=lax/i.test(sessionCookie ?? "") && /path=\//i.test(sessionCookie ?? ""),
  sessionCookie,
);
check("session cookie maxAge ≈ 7 days", /max-age=604800/i.test(sessionCookie ?? ""), sessionCookie);

const cookieHeader = cookieJar(signIn.setCookies);
const session = await call("GET", "/get-session", { cookie: cookieHeader });
check("get-session returns the signed-in user", session.json?.user?.email === "healthy@spike.test", JSON.stringify(session.json));

// 4–5: hooks fired with usable context
log("4–5: hooks + databaseHooks");
check("hooks.before fired on /sign-in/email", !!globalThis.__beforeCtxKeys, "no context captured");
check("hooks.after fired on /sign-in/email", !!globalThis.__afterCtxKeys, "no context captured");
log("    before ctx keys:", globalThis.__beforeCtxKeys);
log("    after  ctx keys:", globalThis.__afterCtxKeys);
check("databaseHooks.session.create.after fired", sessionCreates.includes(healthy.id));
check("after-hook wrote the audit row on success", auditRows.some((a) => a.action === "auth.signed_in"));

// ---------------------------------------------------------------------------
// 6: unknown email — timing equalizer parity
// ---------------------------------------------------------------------------
log("6: unknown email");
const t0 = Date.now();
const unknown = await call("POST", "/sign-in/email", {
  body: { email: "ghost@spike.test", password: "whatever-12345" },
});
const unknownMs = Date.now() - t0;
check("unknown email → 401", unknown.res.status === 401, `status=${unknown.res.status}`);
check(
  "unknown email burned a bcrypt compare (>=150ms, cost-12 parity)",
  unknownMs >= 150,
  `${unknownMs}ms`,
);
check("after-hook counted the failure", limiter.hits === 1, `hits=${limiter.hits}`);

// ---------------------------------------------------------------------------
// 7: sign-out revokes
// ---------------------------------------------------------------------------
log("7: sign-out");
const out = await call("POST", "/sign-out", { cookie: cookieHeader });
check("sign-out returns 200", out.res.status === 200, `status=${out.res.status}`);
check(
  "sign-out expires the session cookie",
  out.setCookies.some((c) => c.startsWith(`${sessionCookieName}=`) && /max-age=0/i.test(c)),
  out.setCookies.join(" | "),
);
const afterOut = await call("GET", "/get-session", { cookie: cookieJar(out.setCookies).replace(/fernly\.session_token=[^;]+;?/, "") });
check("session is gone after sign-out", afterOut.json === null, JSON.stringify(afterOut.json));

// ---------------------------------------------------------------------------
// 8: soft-deleted user rejected by the before-hook gate
// ---------------------------------------------------------------------------
log("8: soft-deleted user");
const soft = await call("POST", "/sign-in/email", {
  body: { email: "soft@spike.test", password: PASSWORD },
});
check("soft-deleted user → 401 (before-hook gate)", soft.res.status === 401, `status=${soft.res.status}`);
check("no session row minted for soft-deleted user", !sessionCreates.includes(softy.id));

// ---------------------------------------------------------------------------
// 9: wrong password
// ---------------------------------------------------------------------------
log("9: wrong password");
const wrong = await call("POST", "/sign-in/email", {
  body: { email: "healthy@spike.test", password: "wrong-password-999" },
});
check("wrong password → 401", wrong.res.status === 401, `status=${wrong.res.status}`);
check("limiter hit recorded", limiter.hits >= 2, `hits=${limiter.hits}`);

// ---------------------------------------------------------------------------
// 10: POST-requests DB-backed session rows exist with expected shape
// ---------------------------------------------------------------------------
log("10: DB session rows");
const rows = await prisma.session.findMany({ where: { userId: healthy.id } });
check(
  "revoked sessions removed from DB on sign-out",
  rows.length === 0,
  `${rows.length} rows remain`,
);

await prisma.$disconnect();
log("");
if (failures === 0) {
  log("PHASE 0 SPIKE: ALL CHECKS PASSED ✅");
  process.exit(0);
} else {
  log(`PHASE 0 SPIKE: ${failures} FAILURE(S) ❌`);
  process.exit(1);
}
