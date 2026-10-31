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

import { db } from "@/lib/db";
import { hashPassword, getMinPasswordLength } from "@/lib/password";
import { createMailer } from "@/lib/mailer";
import { createPasswordResetLimiter } from "@/lib/rate-limit-redis";
import { validationError } from "@/lib/validation";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import crypto from "node:crypto";

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
  const base = process.env.NEXTAUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000";
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

/** F-07 — escape user-controlled text before it lands in an HTML email. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Best-effort client IP for the reset limiter (behind the reverse proxy). */
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
      console.warn(
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
    await db.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    await db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    // Best-effort: a mail provider outage must not break the reset flow.
    try {
      const mailer = createMailer();
      const resetUrl = buildResetUrl(rawToken);
      // F-07 — the display name is user-editable, so escape it before it
      // lands in the HTML part of the email.
      const safeName = escapeHtml(user.name);
      await mailer.sendMail({
        to: user.email,
        subject: "Fernly — reset your password",
        html: `
          <p>Hi ${safeName},</p>
          <p>We received a request to reset your Fernly password. Click the link below to choose a new one:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password is still unchanged.</p>
          <p>The Fernly team</p>
        `,
        text: `Hi ${user.name},\n\nWe received a request to reset your Fernly password. Open this link to choose a new one:\n\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password is still unchanged.\n\nThe Fernly team`,
      });
    } catch (err) {
      console.error("[password-reset] mail send failed:", err);
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
    const newHash = await hashPassword(input.newPassword);
    await db.$transaction([
      db.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: newHash,
          tokenVersion: { increment: 1 },
        },
      }),
      db.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    revalidatePath("/");
    return { success: true };
  });
}
