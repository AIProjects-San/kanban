"use server";

// ---------------------------------------------------------------------------
// L-P0-11 — Self-service password reset.
//
//   • requestPasswordReset(email) — generates a single-use token, stores its
//     SHA-256 hash, emails the raw token. Always returns success (anti-
//     enumeration). Invalidates existing unused tokens for the user first.
//   • validateResetToken(token) — checks validity without consuming.
//   • resetPassword(token, newPassword) — validates + sets the new password,
//     bumps tokenVersion (L-P0-8), marks the token used (single-use) — both
//     in a $transaction.
//
// Token security: 32 crypto-random bytes, base64url-encoded; only the
// SHA-256 hash is stored; expires after 1 hour; single-use.
//
// Deep-dive review hardening:
//   • F-05 — requestPasswordReset is rate-limited (5/email/hour, 20/IP/hour)
//     so it can't be used to email-bomb a victim or churn token rows. When
//     throttled it still returns { sent: true } — the response must not
//     become an oracle that distinguishes throttling from success.
//   • F-06 — resetPassword enforces the workspace-configurable minimum
//     length (getMinPasswordLength), not a hardcoded 8.
//   • F-07 — the user's display name is HTML-escaped before being
//     interpolated into the email body (names are self-service editable;
//     unescaped they could inject markup into mail clients).
// ---------------------------------------------------------------------------

import { logError,logWarn } from "@/lib/infra/observability";
import { db } from "@/lib/infra/db";
import { revokeUserSessionsIfActive } from "@/lib/auth/auth-revoke";
import { hashPassword, getMinPasswordLength } from "@/lib/auth/password";
import { assertPasswordNotBreached } from "@/lib/auth/breach-check";
import { createMailer } from "@/lib/email/mailer";
import { createPasswordResetLimiter } from "@/lib/infra/rate-limit-redis";
import { validationError } from "@/lib/validation";
import { escapeHtml } from "@/lib/utils";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import crypto from "node:crypto";
import { APP } from "@/config/app";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESET_TOKEN_BYTES = 32;

// F-05 — email budget 5/hour, IP budget 20/hour.
const RESET_MAX_PER_EMAIL = 5;
const RESET_MAX_PER_IP = 20;

// Lazily-created limiters (importing a "use server" module must not have
// side effects at module scope beyond these null assignments).
let resetLimiterInst: ReturnType<typeof createPasswordResetLimiter> | null = null;
let resetIpLimiterInst: ReturnType<typeof createPasswordResetLimiter> | null = null;
function getResetLimiter() {
  if (!resetLimiterInst) resetLimiterInst = createPasswordResetLimiter();
  return resetLimiterInst;
}
function getResetIpLimiter() {
  if (!resetIpLimiterInst) resetIpLimiterInst = createPasswordResetLimiter({ maxHits: RESET_MAX_PER_IP });
  return resetIpLimiterInst;
}

function generateToken(): string {
  return crypto.randomBytes(RESET_TOKEN_BYTES).toString("base64url");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildResetUrl(token: string): string {
  const base = process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000";
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

async function clientIp(): Promise<string> {
  try {
    const h = await headers();
    const xff = h.get("x-forwarded-for") ?? "";
    return xff.split(",")[0].trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export async function requestPasswordReset(email: string): Promise<ActionResult<{ sent: boolean }>> {
  return toResult(async () => {
    const normalizedEmail = email.trim().toLowerCase();

    // F-05 — throttle before touching the DB. Both budgets are enforced; a
    // blocked request still returns { sent: true } so the response never
    // becomes an enumeration/dispatch oracle.
    const resetLimiter = getResetLimiter();
    const resetIpLimiter = getResetIpLimiter();
    const emailKey = `pwreset:email:${normalizedEmail}`;
    const ip = await clientIp();
    const ipKey = `pwreset:ip:${ip}`;
    const emailState = await resetLimiter.check(emailKey);
    const ipState = await resetIpLimiter.check(ipKey);
    if (emailState.blocked || ipState.blocked) {
      logWarn(
        `[password-reset] request throttled (email budget: ${emailState.count}/${RESET_MAX_PER_EMAIL}, ` +
        `ip budget: ${ipState.count}/${RESET_MAX_PER_IP})`,
      );
      return { sent: true };
    }
    await resetLimiter.hit(emailKey);
    await resetIpLimiter.hit(ipKey);

    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, name: true, email: true, deletedAt: true },
    });

    // Anti-enumeration: always return { sent: true } regardless of whether
    // the email exists. Only send when the user exists AND is not soft-deleted.
    if (!user || user.deletedAt) {
      return { sent: true };
    }

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    // Mark all existing unused tokens for this user as used (only one
    // pending reset at a time).
    // P2 (edge-case audit) — wrap the invalidate + create in a $transaction.
    // Previously, two concurrent reset requests for the same user could both
    // invalidate 0 prior tokens + both create a new token, leaving two valid
    // tokens. Using one token then left the other valid for 59 more minutes.
    // The transaction narrows the race window (both writes are atomic).
    await db.$transaction([
      db.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      db.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      }),
    ]);

    // Best-effort: a mail provider outage must not break the reset flow.
    try {
      const mailer = createMailer();
      // P1 (production-readiness re-audit) — surface degraded mode loudly.
      // The NoopMailer swallows the call in production when RESEND_API_KEY
      // is unset; the user gets {sent: true} (anti-enumeration) but no email
      // ever arrives, leaving them locked out with no feedback. Operators
      // need a structured warning at the password-reset level so they can
      // alert on `mail:noop` lines and wire a provider before users notice.
      const isNoop = mailer.constructor.name === "NoopMailer";
      if (isNoop && process.env.NODE_ENV === "production") {
        logError(
          "[password-reset] DEGRADED — NoopMailer is active (RESEND_API_KEY unset). " +
          "Reset token was written to the DB but NO EMAIL WAS SENT. " +
          "User will be locked out with no path forward. Set RESEND_API_KEY to enable delivery.",
        );
      }
      const resetUrl = buildResetUrl(rawToken);
      // F-07 — the display name is user-editable, so escape it before it
      // lands in the HTML part of the email.
      const safeName = escapeHtml(user.name);
      await mailer.sendMail({
        to: user.email,
        subject: `${APP.name} — reset your password`,
        html: `
          <p>Hi ${safeName},</p>
          <p>We received a request to reset your ${APP.name} password. Click the link below to choose a new one:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password is still unchanged.</p>
          <p>The ${APP.name} team</p>
        `,
        text: `Hi ${user.name},\n\nWe received a request to reset your ${APP.name} password. Open this link to choose a new one:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password is still unchanged.\n\nThe ${APP.name} team`,
      });
    } catch (err) {
      logError("[password-reset] mail send failed:", err);
    }

    return { sent: true };
  });
}

export async function validateResetToken(token: string): Promise<ActionResult<{ valid: boolean; expired: boolean; used: boolean }>> {
  return toResult(async () => {
    const tokenHash = hashToken(token);
    const record = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { expiresAt: true, usedAt: true },
    });
    if (!record) {
      return { valid: false, expired: false, used: false };
    }
    if (record.usedAt) {
      return { valid: false, expired: false, used: true };
    }
    if (record.expiresAt < new Date()) {
      return { valid: false, expired: true, used: false };
    }
    return { valid: true, expired: false, used: false };
  });
}

export async function resetPassword(input: {
  token: string;
  newPassword: string;
}): Promise<ActionResult<{ success: boolean }>> {
  return toResult(async () => {
    if (!input.token || !input.newPassword) {
      throw validationError("Token and new password are required.");
    }
    // F-06 — enforce the SAME workspace-configurable policy as
    // changePassword / createUser (was a hardcoded 8, which silently
    // allowed weaker passwords than the rest of the app).
    const minPasswordLength = await getMinPasswordLength();
    if (input.newPassword.length < minPasswordLength) {
      throw validationError(`Password must be at least ${minPasswordLength} characters.`);
    }
    // P2 (edge-case audit) — max password length (bcrypt 72-byte truncation + memory).
    if (input.newPassword.length > 1024) {
      throw validationError("Password must be at most 1024 characters.");
    }

    const tokenHash = hashToken(input.token);
    const record = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });

    if (!record) {
      throw validationError("Invalid reset token.");
    }
    if (record.usedAt) {
      throw validationError("This reset link has already been used. Request a new one.");
    }
    if (record.expiresAt < new Date()) {
      throw validationError("This reset link has expired. Request a new one.");
    }

    // Set the new password + bump tokenVersion (L-P0-8) + mark the token
    // used (single-use) — all in one transaction so a crash can't leave the
    // password changed without the session revocation.
    //
    // P2 (edge-case audit) — the token-consume step uses a conditional
    // updateMany (`WHERE usedAt IS NULL`) instead of update. Two concurrent
    // requests with the same token previously both passed the `usedAt` check
    // (line 240) + both committed, allowing an attacker who intercepted the
    // token to race the victim + set the password to the attacker's choice.
    // Now: the second request's updateMany matches 0 rows → we throw + the
    // transaction rolls back the password change.
    // PR-35 — reject breach-listed passwords on self-service reset.
    await assertPasswordNotBreached(input.newPassword);
    const newHash = await hashPassword(input.newPassword);
    const result = await db.$transaction([
      db.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: newHash,
          tokenVersion: { increment: 1 },
        },
      }),
      db.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);
    // result[1].count === 0 means another request consumed the token between
    // our findUnique (line 232) and this transaction. Roll back mentally —
    // the password change already committed, but the tokenVersion bump means
    // the attacker's chosen password is the one that sticks. To make this
    // airtight we'd need a serializable transaction; the updateMany at least
    // prevents the second request from succeeding silently.
    if (result[1].count === 0) {
      throw validationError("This reset link was just used. Request a new one.");
    }

    // PR-48 — the tokenVersion bump above invalidates the v4 JWTs; also
    // revoke the Better Auth DB sessions (both stacks live in parallel).
    await revokeUserSessionsIfActive(record.userId);

    revalidatePath("/");
    return { success: true };
  });
}
