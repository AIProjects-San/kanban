// ---------------------------------------------------------------------------
// PR-48 — Better Auth parallel stack (auth migration Phase 1).
// docs/AUTH_MIGRATION_PLAN.md §5–§6 (port map updated by the Phase 0 spike).
//
// This module is the Better Auth 1.7 counterpart of `src/lib/auth.ts`. It
// serves `/api/auth-better/*` while NextAuth v4 keeps serving `/api/auth/*`;
// production traffic is untouched until NEXT_PUBLIC_AUTH_STACK flips to
// "better" (Phase 3 cutover). Every piece of custom logic from authorize()
// is ported here (§6 port map):
//
//   • brute-force throttle (email + IP budgets, SAME limiter store as v4 —
//     an attacker hammering both endpoints draws from one budget)
//   • timing-attack dummy bcrypt (cost 12, identical hash)
//   • soft-deleted-user rejection (before-hook gate + session.create backstop)
//   • sign-in / sign-out audit rows with IP + user agent
//   • 7-day session expiry; the v4 5-minute role refresh becomes the
//     session cookie cache (maxAge 300)
//   • `User.passwordHash` stays the single credential source of truth — the
//     before-hook syncs 1.7 credential Account rows lazily (spike F3), so
//     password changes through EITHER stack are picked up on the next
//     sign-in with exactly one bcrypt compare per attempt.
//
// Revocation semantics change for the better stack: v4 bumped tokenVersion
// and let the jwt callback notice (≤5 min). The better stack deletes the
// user's DB session rows via `revokeUserSessions()` — immediate for DB
// lookups, ≤5 min for the cookie cache (same worst-case window as v4).
// ---------------------------------------------------------------------------

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware, APIError } from "better-auth/api";
import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { createLoginLimiter } from "@/lib/rate-limit-redis";
import { logError, logWarn } from "@/lib/observability";
import { hashPii } from "@/lib/pii";
import { isValidRole, type Role } from "@/lib/rbac";
import { extractClientIp } from "@/lib/auth-request-context";

// ---------------------------------------------------------------------------
// Stack flag — single env var readable by BOTH server and client (client
// code imports the value through `src/lib/auth-stack.ts`, never this file).
// ---------------------------------------------------------------------------

export function isBetterAuthStack(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_STACK === "better";
}

// ---------------------------------------------------------------------------
// Secret handling — identical contract to src/lib/auth.ts (P0-6): refuse to
// boot in production on a missing/weak secret, allow the build phase, and
// fall back to NEXTAUTH_SECRET during the parallel period so operators
// manage ONE signing secret until the Phase 3 cleanup renames it.
// ---------------------------------------------------------------------------

const WEAK_SECRET_PREFIX = "fernly-dev-secret";

function resolveBetterSecret(): string {
  const secret =
    process.env.BETTER_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
  const isWeak = !secret || secret.startsWith(WEAK_SECRET_PREFIX);
  const isBuild = process.env.NEXT_PHASE === "phase-production-build";

  if (isWeak && process.env.NODE_ENV === "production" && !isBuild) {
    throw new Error(
      "BETTER_AUTH_SECRET (or NEXTAUTH_SECRET) is missing or uses the " +
        "development default. Generate a strong secret (openssl rand " +
        "-base64 32) and set it before starting the server — session " +
        "tokens are forgeable otherwise.",
    );
  }
  if (isWeak) {
    logWarn(
      "[auth-better] secret not set (or is the dev default) — using an " +
        "ephemeral secret. Sessions will reset on server restart.",
    );
    return crypto.randomUUID();
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Prisma adapter (ADR-008): the provider is derived from the effective
// DATABASE_URL protocol — exactly the rule scripts/run-with-env.sh applies
// to the Prisma CLI. SQLite (file:) runs the sandbox preview; postgresql://
// runs CI e2e, docker-compose and production. Spike finding F1.
// ---------------------------------------------------------------------------

function adapterProvider(): "sqlite" | "postgresql" {
  const url = process.env.DATABASE_URL ?? "";
  return url.startsWith("file:") ? "sqlite" : "postgresql";
}

// L-P0-10 — same factory as v4: Redis-backed limiter when REDIS_URL is set,
// in-memory otherwise. Because both stacks build from the same module state,
// the budgets are SHARED across /api/auth/* and /api/auth-better/*.
const loginLimiter = createLoginLimiter();

// P2 edge-case audit — same cost-12 dummy hash as src/lib/auth.ts: burns an
// identical bcrypt compare when the account doesn't exist or is soft-deleted
// so response times never reveal whether an email is registered.
const DUMMY_HASH =
  "$2b$12$llbxFwXYn3xp2mUpBZUk3ec17zATv43gw0rBZq1kItXp3H11.q5UO";

// Mirrors next.config.ts `serverActionsAllowedOrigins` (audit §1.15): env
// override first, then the conservative preview default. Better Auth's
// origin check (its CSRF posture — no double-submit token to keep in sync)
// must accept exactly the origins Server Actions accept. NOTE the format
// difference: non-wildcard entries must be FULL origins (scheme included —
// matchesOriginPattern compares against getOrigin()); wildcard entries
// match on host alone. The prod-smoke origins (127.0.0.1:3111, SMOKE_PORT
// default) are included so the standalone smoke build passes the same gate.
function trustedOrigins(): string[] {
  const env = process.env.SERVER_ACTIONS_ALLOWED_ORIGINS;
  if (env) {
    return env
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
      // Bare host(:port) entries from the Server Actions format can't match
      // a full-origin comparison — normalize them onto the dev scheme.
      .map((o) => (/^[a-z0-9.-]+(:\d+)?$/i.test(o) ? `http://${o}` : o));
  }
  return [
    "*.space-z.ai",
    "*.fcapp.run",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:81",
    "http://localhost:3111",
    "http://127.0.0.1:3111",
  ];
}

const isProd = process.env.NODE_ENV === "production";

// ---------------------------------------------------------------------------
// Hook-local helpers
// ---------------------------------------------------------------------------

/** Normalise a submitted email exactly like v4 authorize() (P2 edge-case). */
function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Client IP for the hook's request — trusted-proxy order shared with v4. */
function ipFromRequest(request: Request | undefined): string {
  if (!request) return "unknown";
  return extractClientIp((name) => request.headers.get(name));
}

function userAgentFromRequest(request: Request | undefined): string {
  return request?.headers.get("user-agent") ?? "unknown";
}

/** Numeric HTTP status off the after-hook's returned payload (spike F5). */
function returnedStatus(returned: unknown): number {
  if (returned instanceof Response) return returned.status;
  if (typeof returned === "object" && returned !== null) {
    const r = returned as { statusCode?: unknown; status?: unknown };
    if (typeof r.statusCode === "number") return r.statusCode;
    if (typeof r.status === "number") return r.status;
  }
  return 200;
}

// ---------------------------------------------------------------------------
// The instance
// ---------------------------------------------------------------------------

export const auth = betterAuth({
  appName: "Fernly",
  // basePath/baseURL: the handler is mounted at /api/auth-better (Phase 1
  // parallel routing). baseURL is derived per-request by Better Auth when
  // unset; only the origin allow-list pins preview domains.
  basePath: "/api/auth-better",
  secret: resolveBetterSecret(),
  database: prismaAdapter(db, { provider: adapterProvider() }),
  emailAndPassword: {
    enabled: true,
    // The app provisions accounts itself (admin Users panel + seed); the
    // Better Auth sign-up endpoint must never mint users.
    disableSignUp: true,
    minPasswordLength: 8,
    // bcryptjs cost 12 — identical to src/lib/password.ts. Better Auth
    // calls hash() itself on the unknown-email path, so the built-in timing
    // equaliser burns the SAME work factor as v4 (spike-verified).
    password: {
      hash: (pw) => bcrypt.hash(pw, 12),
      verify: async ({ password, hash }) => bcrypt.compare(password, hash),
    },
  },
  user: {
    // Better Auth's default model name "user" maps straight onto the
    // existing Prisma model (client property `db.user`) — mapped, not
    // duplicated. role/tokenVersion/deletedAt ride along as additional
    // fields so auth.api.getSession() returns them without extra queries
    // (deletedAt powers the mid-session soft-delete guard in
    // getBetterSession — v4 jwt-callback parity).
    additionalFields: {
      role: { type: "string", input: false },
      tokenVersion: { type: "number", input: false },
      deletedAt: { type: "date", input: false },
    },
  },
  session: {
    // 7 days — parity with the v4 JWT maxAge (L-P0-8 defence in depth).
    expiresIn: 7 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
    // 5-minute cookie cache = the v4 ROLE_REFRESH_MS window: role changes
    // propagate on cache expiry, revocations ride the same window, and DB
    // load stays one lookup per 5 minutes instead of per request.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  advanced: {
    cookiePrefix: "fernly",
    useSecureCookies: isProd,
    database: {
      // Spike finding F2 — the brownfield User carries required app-only
      // columns (passwordHash…) Better Auth never writes; the runtime schema
      // validator false-positives on those. Our migrations + CI e2e own the
      // schema contract instead.
      validateSchema: false,
    },
    ipAddress: {
      // extractClientIp (trusted-proxy order: x-real-ip, then the LAST
      // x-forwarded-for hop) already runs in the hooks; Better Auth's own
      // IP extraction (rate limiting, session rows) gets the same headers.
      ipAddressHeaders: ["x-real-ip", "x-forwarded-for"],
    },
  },
  trustedOrigins: trustedOrigins(),
  hooks: {
    // -----------------------------------------------------------------
    // /sign-in/email — the authorize() port (§6 port map rows 1–4).
    // -----------------------------------------------------------------
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-out") {
        // 1.7's signOut endpoint resolves the session cookie itself and
        // never surfaces the user on the context the after-hook sees — so
        // the audit row's identity is resolved HERE and stashed on the
        // context (the before-hook's returned context merges into the one
        // the after-hook receives — verified in dispatch.mjs). A missing or
        // unverifiable cookie stashes nothing; the after-hook no-ops, which
        // is exactly v4's events.signOut guard (no user → no row).
        try {
          const cookieName = ctx.context.authCookies.sessionToken.name;
          const token = await ctx.getSignedCookie(cookieName, ctx.context.secret);
          if (token) {
            const row = await db.session.findUnique({
              where: { token },
              select: {
                user: {
                  select: { id: true, name: true, role: true, email: true },
                },
              },
            });
            if (row) return { context: { fernlySignOutUser: row.user } };
          }
        } catch {
          // Unverifiable/expired cookie — treat as "already signed out".
        }
        return { context: {} };
      }

      if (ctx.path !== "/sign-in/email") return;

      const email = normalizeEmail(ctx.body?.email);
      const password =
        typeof ctx.body?.password === "string" ? ctx.body.password : "";
      if (!email || !password) {
        throw new APIError("BAD_REQUEST", { message: "invalid credentials" });
      }
      // P2 edge-case parity — normalise the body the endpoint will validate
      // and look up (trim + lowercase). ctx.body is spread-copied by the
      // hook runner but the object itself is shared, so a property write
      // reaches the endpoint handler. Without this, " ada@x.co " dies at
      // Better Auth's z.email() check on the RAW value.
      ctx.body.email = email;

      const ip = ipFromRequest(ctx.request);
      const emailKey = `login:email:${email}`;
      const ipKey = `login:ip:${ip}`;

      // Brute-force throttle BEFORE touching the database — same budgets,
      // same keys, same store as the v4 stack (shared defence).
      const emailState = await loginLimiter.check(emailKey);
      const ipState = await loginLimiter.check(ipKey);
      if (emailState.blocked || ipState.blocked) {
        logWarn(
          `[auth-better] login throttled (email budget exhausted, ip hash ${hashPii(ip)})`,
        );
        throw new APIError("TOO_MANY_REQUESTS", { message: "throttled" });
      }

      // Soft-delete filter + DB-outage containment in one lookup (P0/P1
      // audits — same contract as v4 authorize()).
      let user: {
        id: string;
        name: string;
        email: string;
        role: string;
        passwordHash: string;
        deletedAt: Date | null;
      } | null = null;
      try {
        user = await db.user.findUnique({
          where: { email, deletedAt: null },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            passwordHash: true,
            deletedAt: true,
          },
        });
      } catch (err) {
        logError("[auth-better] DB unavailable during sign-in:", err);
        throw new APIError("UNAUTHORIZED", { message: "invalid credentials" });
      }

      if (!user) {
        // Timing equaliser — identical dummy compare to v4 (spike F3/F4: a
        // plain Error would 500; APIError controls the status code).
        try {
          await bcrypt.compare(password, DUMMY_HASH);
        } catch {
          /* corrupted dummy hash — swallow, the throw below still happens */
        }
        throw new APIError("UNAUTHORIZED", { message: "invalid credentials" });
      }

      // Spike F3 — 1.7 keeps credentials on Account rows; User.passwordHash
      // stays authoritative. Sync the credential row (create on first use,
      // refresh after a password change through either stack) so Better
      // Auth's own verify — the single bcrypt compare of this request —
      // always runs against the current hash.
      try {
        const cred = await db.account.findUnique({
          where: {
            providerId_accountId: { providerId: "credential", accountId: user.id },
          },
          select: { password: true },
        });
        if (!cred || cred.password !== user.passwordHash) {
          await db.account.upsert({
            where: {
              providerId_accountId: {
                providerId: "credential",
                accountId: user.id,
              },
            },
            create: {
              accountId: user.id,
              providerId: "credential",
              userId: user.id,
              password: user.passwordHash,
            },
            update: { password: user.passwordHash },
          });
        }
      } catch (err) {
        // The bridge failing is a failed sign-in, not a bypass: Better Auth
        // verifies against the (stale/missing) account row and rejects.
        logError("[auth-better] credential bridge failed during sign-in:", err);
        throw new APIError("UNAUTHORIZED", { message: "invalid credentials" });
      }

      return { context: {} };
    }),

    // -----------------------------------------------------------------
    // after — limiter accounting + audit rows (§6 rows 5–7).
    // -----------------------------------------------------------------
    after: createAuthMiddleware(async (ctx) => {
      // ---- sign-in accounting --------------------------------------
      if (ctx.path === "/sign-in/email") {
        const email = normalizeEmail(ctx.body?.email);
        const ip = ipFromRequest(ctx.request);
        const emailKey = `login:email:${email}`;
        const ipKey = `login:ip:${ip}`;
        const status = returnedStatus(ctx.context.returned);

        if (status >= 400) {
          // Failed attempt (wrong password / unknown email / throttled
          // before-hook) — charge both budgets, exactly like v4.
          await loginLimiter.hit(emailKey);
          await loginLimiter.hit(ipKey);
          return;
        }

        // Successful sign-in — clear BOTH budgets (PR-11 shared-NAT fix)
        // and write the audit row (IP + UA for post-incident forensics).
        await loginLimiter.reset(emailKey);
        await loginLimiter.reset(ipKey);
        try {
          const user = await db.user.findUnique({
            where: { email, deletedAt: null },
            select: { id: true, name: true, role: true, email: true },
          });
          if (user) {
            await db.auditLog.create({
              data: {
                actorId: user.id,
                actorName: user.name,
                actorRole: user.role,
                action: "auth.signed_in",
                entityType: "AUTH",
                entityLabel: user.email,
                detail: `${user.name} signed in to the workspace`,
                ipAddress: ip,
                userAgent: userAgentFromRequest(ctx.request).slice(0, 500),
              },
            });
          }
        } catch (err) {
          // Best-effort, like v4: an audit failure must never block a
          // sign-in that already succeeded.
          logError("[auth-better] failed to log sign-in:", err);
        }
        return;
      }

      // ---- sign-out audit row (§6 row 7) ----------------------------
      if (ctx.path === "/sign-out") {
        // The before-hook stashed the user it resolved from the session
        // cookie (the endpoint deletes the row before we get here). A null
        // stash means no valid session was signed out — no row, matching
        // v4's events.signOut guard.
        const user = (ctx as { fernlySignOutUser?: { id: string; name: string; role: string; email: string } })
          .fernlySignOutUser;
        if (!user) return;
        try {
          await db.auditLog.create({
            data: {
              actorId: user.id,
              actorName: user.name,
              actorRole: user.role,
              action: "auth.signed_out",
              entityType: "AUTH",
              entityLabel: user.email,
              detail: `${user.name} signed out of the workspace`,
              ipAddress: ipFromRequest(ctx.request),
              userAgent: userAgentFromRequest(ctx.request).slice(0, 500),
            },
          });
        } catch (err) {
          logError("[auth-better] failed to log sign-out:", err);
        }
        return;
      }
    }),
  },
  databaseHooks: {
    session: {
      create: {
        // DB-level backstop: even if a future code path bypasses the
        // before-hook gate, a soft-deleted user must never mint a session.
        // (Void = allow, false = block — the hook contract.)
        before: async (session) => {
          try {
            const u = await db.user.findUnique({
              where: { id: session.userId },
              select: { deletedAt: true },
            });
            if (u?.deletedAt) return false;
          } catch (err) {
            logError(
              "[auth-better] session.create backstop lookup failed:",
              err,
            );
            return false;
          }
        },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Server-side session helper — the getSession() counterpart of
// server-actions/auth-guard.ts. Returns the same normalized AuthResult
// shape so requirePermission() and friends stay stack-agnostic.
// ---------------------------------------------------------------------------

export interface BetterAuthSession {
  userId: string;
  role: Role;
  name: string;
  email: string;
}

export async function getBetterSession(): Promise<BetterAuthSession | null> {
  try {
    const session = await auth.api.getSession({
      headers: new Headers(await headers()),
    });
    if (!session?.user?.id) return null;
    // Soft-deleted mid-session — treat as signed out even if a session row
    // survived (v4 parity: the jwt callback's refresh path cleared the
    // identity claim for deletedAt != null). The additionalField means no
    // extra query: deletedAt rides on the session payload.
    const deletedAt = (session.user as { deletedAt?: unknown }).deletedAt;
    if (deletedAt instanceof Date && deletedAt.getTime() <= Date.now()) {
      return null;
    }
    const roleRaw = (session.user as { role?: unknown }).role;
    const role: Role = isValidRole(typeof roleRaw === "string" ? roleRaw : "")
      ? (roleRaw as Role)
      : "MEMBER";
    return {
      userId: session.user.id,
      role,
      name: session.user.name ?? "",
      email: session.user.email ?? "",
    };
  } catch (err) {
    logError("[auth-better] getSession failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Revocation — the tokenVersion counterpart (§6 row 6). Called by the
// password-change / role-change / soft-delete / sign-out-everywhere flows
// right after they bump tokenVersion. Inert while the v4 stack serves
// traffic (v4 revocation is the JWT refresh check); at cutover it becomes
// the immediate kill switch. Best-effort by design — the tokenVersion bump
// already logged the intent, and a failed delete retries on the next bump.
// ---------------------------------------------------------------------------

export async function revokeUserSessions(userId: string): Promise<void> {
  if (!isBetterAuthStack()) return;
  try {
    await db.session.deleteMany({ where: { userId } });
  } catch (err) {
    logError("[auth-better] failed to revoke user sessions:", err);
  }
}

// ---------------------------------------------------------------------------
// Cookie names (mirrors lib/auth-cookies.ts). The proxy and the client
// sign-out path need them; attributes are pinned by the betterAuth config
// (httpOnly + SameSite=Lax + Path=/ + Secure in prod — spike-verified).
// ---------------------------------------------------------------------------

export const BETTER_AUTH_COOKIE_NAMES = [
  "fernly.session_token",
  "fernly.session_data",
  "__Secure-fernly.session_token",
  "__Secure-fernly.session_data",
] as const;
