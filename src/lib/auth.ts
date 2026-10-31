import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { createLoginLimiter } from "@/lib/rate-limit-redis";
import { hashPii, logError, logWarn } from "@/lib/observability";

// L-P0-10 — pick the Redis-backed limiter when REDIS_URL + a Redis client
// are configured, fall back to the in-memory limiter otherwise.
const loginLimiter = createLoginLimiter();

// ---------------------------------------------------------------------------
// Secret handling
// ---------------------------------------------------------------------------
// In production a missing or known-weak NEXTAUTH_SECRET means anyone can
// forge session JWTs, so we refuse to boot. During `next build`
// (NEXT_PHASE=phase-production-build) we skip the throw so the build itself
// can succeed on machines that (correctly) only inject secrets at runtime.

const WEAK_SECRET_PREFIX = "fernly-dev-secret";

function resolveSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET ?? "";
  const isWeak = !secret || secret.startsWith(WEAK_SECRET_PREFIX);
  const isBuild = process.env.NEXT_PHASE === "phase-production-build";

  if (isWeak && process.env.NODE_ENV === "production" && !isBuild) {
    throw new Error(
      "NEXTAUTH_SECRET is missing or uses the development default. " +
      "Generate a strong secret (openssl rand -base64 32) and set it before " +
      "starting the server — session tokens are forgeable otherwise.",
    );
  }
  if (isWeak) {
    // Dev only: ephemeral random secret so we never sign with a public constant.
    logWarn(
      "[auth] NEXTAUTH_SECRET not set (or is the dev default) — using an " +
      "ephemeral secret. Sessions will reset on server restart.",
    );
    return crypto.randomUUID();
  }
  return secret;
}

const isProd = process.env.NODE_ENV === "production";

// How often the JWT callback re-reads the user's role from the database.
// Keeps role changes effective within minutes without hammering the DB on
// every single request.
const ROLE_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    // L-P0-8 — shortened from 30 days to 7 days as defence in depth. With
    // tokenVersion revocation now in place, a stolen cookie is invalidated
    // the moment the user rotates their password; the shorter maxAge caps
    // the worst-case exposure for users who DON'T notice the compromise.
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },
  pages: {
    signIn: "/",
  },
  // Trust the proxy's forwarded headers so NextAuth detects the correct
  // scheme/host in preview environments (HTTPS gateway → HTTP internal).
  // In production we require secure cookies since traffic is HTTPS.
  useSecureCookies: isProd,
  cookies: {
    sessionToken: {
      name: "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
    callbackUrl: {
      name: "next-auth.callback-url",
      options: {
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
    csrfToken: {
      name: "next-auth.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email.toLowerCase();
        // Best-effort client IP + user agent (behind the reverse proxy).
        const headers = req?.headers ?? {};
        const xff =
          (typeof headers["x-forwarded-for"] === "string" && headers["x-forwarded-for"]) || "";
        const ip = xff.split(",")[0].trim() || "unknown";
        // P1 (production-readiness re-audit) — capture the user agent for the
        // audit log so post-incident forensics can tie a sign-in to a browser.
        const userAgent =
          (typeof headers["user-agent"] === "string" && headers["user-agent"]) || "unknown";
        const emailKey = `login:email:${email}`;
        const ipKey = `login:ip:${ip}`;

        // Brute-force throttle: block before touching the database when the
        // email or the source IP is over the attempt budget.
        // L-P0-10: limiter is now async (Redis-backed when REDIS_URL is set).
        const emailState = await loginLimiter.check(emailKey);
        const ipState = await loginLimiter.check(ipKey);
        if (emailState.blocked || ipState.blocked) {
          // P1 (production-readiness re-audit) — PII scrub. Login emails and
          // source IPs are personal data under NZ Privacy Act 2020 / GDPR;
          // logging them in cleartext creates a retention burden and a leak
          // surface. Log a hashed identifier instead so operators can still
          // correlate events for the same user without storing the address.
          logWarn(`[auth] login throttled (email budget exhausted, ip hash ${hashPii(ip)})`);
          return null;
        }

        // P0 (production-readiness re-audit) — filter soft-deleted users at
        // the lookup. Without this, a user soft-deleted via deleteUser() could
        // still sign in with their original password. The L-P0-14 soft-delete
        // model relies on this filter; the prior comment "implicitly
        // invalidated" was wrong (findUnique returns soft-deleted rows).
        const user = await db.user.findUnique({ where: { email, deletedAt: null } });
        if (!user) {
          // Timing-attack mitigation: burn the same bcrypt work factor when
          // the account doesn't exist so response times don't reveal whether
          // an email is registered. Audit §1.2: the dummy hash is cost 12 to
          // EXACTLY match production hashing (src/lib/password.ts) — the
          // previous cost-10 dummy left a measurable unknown-email signal.
          await bcrypt.compare(
            credentials.password,
            // Precomputed hash of a random throwaway string (cost 12). The
            // plaintext was discarded after generation; every compare fails.
            "$2b$12$llbxFwXYn3xp2mUpBZUk3ec17zATv43gw0rBZq1kItXp3H11.q5UO",
          );
          await loginLimiter.hit(emailKey);
          await loginLimiter.hit(ipKey);
          return null;
        }
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) {
          await loginLimiter.hit(emailKey);
          await loginLimiter.hit(ipKey);
          return null;
        }
        // Successful sign-in clears the per-email budget (a legit user who
        // mistyped their password a few times shouldn't stay blocked).
        await loginLimiter.reset(emailKey);
        // Audit trail: record successful sign-ins (with source IP + UA —
        // P1 production-readiness re-audit for post-incident forensics).
        try {
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
              userAgent: userAgent.slice(0, 500),
            },
          });
        } catch (err) {
          logError("[audit] failed to log sign-in:", err);
        }
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          // L-P0-8 — stamp the tokenVersion so the jwt callback can detect
          // revocation on subsequent refreshes.
          tokenVersion: user.tokenVersion,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Initial sign-in — stamp the token with the current role and the
        // current tokenVersion (L-P0-8 session revocation).
        token.id = user.id;
        token.role = user.role;
        token.tokenVersion = user.tokenVersion ?? 0;
        token.roleCheckedAt = Date.now();
      } else if (
        typeof token.roleCheckedAt !== "number" ||
        Date.now() - (token.roleCheckedAt as number) > ROLE_REFRESH_MS
      ) {
        // Periodically re-read the role AND tokenVersion from the database
        // so promotions, demotions, and revocations take effect without
        // waiting for the JWT to expire.
        // P0 (production-readiness re-audit) — filter soft-deleted users.
        // A user soft-deleted mid-session must have their token cleared just
        // like a hard-deleted user. Select deletedAt and treat non-null as
        // invalidation.
        const fresh = await db.user.findUnique({
          where: { id: token.id as string, deletedAt: null },
          select: { role: true, tokenVersion: true, deletedAt: true },
        });
        if (fresh && fresh.deletedAt === null) {
          // L-P0-8 — reject tokens whose tokenVersion is stale. The user
          // (or an admin) bumped tokenVersion after this token was issued,
          // which means the password or role changed. Invalidate the
          // identity claim; the app treats an empty id as "not signed in".
          //
          // Defensive: treat undefined values as 0 so legacy rows / partial
          // mocks can't false-positive invalidate a session.
          const dbVersion = typeof fresh.tokenVersion === "number" ? fresh.tokenVersion : 0;
          const tokenVersion = typeof token.tokenVersion === "number" ? token.tokenVersion : 0;
          if (dbVersion !== tokenVersion) {
            logWarn(
              `[auth] token version mismatch for user ${token.id} — ` +
              `token has ${tokenVersion}, DB has ${dbVersion}. ` +
              `Session invalidated (password or role changed).`,
            );
            token.id = "";
            token.role = "MEMBER";
            token.tokenVersion = dbVersion;
          } else {
            token.role = fresh.role;
            token.tokenVersion = dbVersion;
          }
        } else {
          // Account deleted OR soft-deleted mid-session — invalidate the
          // identity claim; the app treats an empty id as "not signed in".
          // (The `deletedAt: null` filter above means soft-deleted users
          // return null here, so their tokens are cleared within the
          // ROLE_REFRESH_MS window.)
          token.id = "";
          token.role = "MEMBER";
        }
        token.roleCheckedAt = Date.now();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
      }
      return session;
    },
  },
  events: {
    // NextAuth fires this *after* it has already expired the session-token
    // cookie — the route wrapper in app/api/auth/[...nextauth]/route.ts
    // then also expires the CSRF + callback-url cookies. We use the event
    // purely to keep the audit trail symmetric with `auth.signed_in`.
    // Best-effort: a DB outage here must NOT prevent the sign-out from
    // completing.
    async signOut(message) {
      const id = (message as { token?: { id?: string } }).token?.id;
      if (!id) return;
      try {
        const user = await db.user.findUnique({
          where: { id },
          select: { id: true, name: true, role: true, email: true },
        });
        if (!user) return;
        await db.auditLog.create({
          data: {
            actorId: user.id,
            actorName: user.name,
            actorRole: user.role,
            action: "auth.signed_out",
            entityType: "AUTH",
            entityLabel: user.email,
            detail: `${user.name} signed out of the workspace`,
          },
        });
      } catch (err) {
        logError("[audit] failed to log sign-out:", err);
      }
    },
  },
  secret: resolveSecret(),
};
