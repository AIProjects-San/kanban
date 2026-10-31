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
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createMailer } from "@/lib/mailer";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { revalidatePath } from "next/cache";
import crypto from "node:crypto";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const RESET_TOKEN_BYTES = 32;

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

export async function requestPasswordReset(email: string): Promise<ActionResult<{ sent: boolean }>> {
  return toResult(async () => {
    const normalizedEmail = email.trim().toLowerCase();
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
      await mailer.sendMail({
        to: user.email,
        subject: "Fernly — reset your password",
        html: `
          <p>Hi ${user.name},</p>
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
      throw new Error("Token and new password are required.");
    }
    if (input.newPassword.length < 8) {
      throw new Error("Password must be at least 8 characters.");
    }

    const tokenHash = hashToken(input.token);
    const record = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });

    if (!record) {
      throw new Error("Invalid reset token.");
    }
    if (record.usedAt) {
      throw new Error("This reset link has already been used. Request a new one.");
    }
    if (record.expiresAt < new Date()) {
      throw new Error("This reset link has expired. Request a new one.");
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
