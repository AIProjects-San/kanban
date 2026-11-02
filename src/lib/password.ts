// ---------------------------------------------------------------------------
// Password policy — single source of truth for hashing and strength rules.
//
// The minimum length is workspace-configurable (Workspace.minPasswordLength);
// everything else (cost factor, charset rules) is enforced here.
// ---------------------------------------------------------------------------

import bcrypt from "bcryptjs";
import { getWorkspaceConfig } from "@/lib/config-loader";

/** Bcrypt work factor. 12 ≈ 250ms/hash on 2025-era hardware — a deliberate
 *  slowdown for attackers that is still acceptable for interactive login. */
export const BCRYPT_COST = 12;

/** Hard floor regardless of workspace configuration. */
export const ABSOLUTE_MIN_PASSWORD_LENGTH = 8;

/**
 * The workspace-configured minimum password length (falls back to 8 when the
 * config table is empty or the value is nonsensical).
 */
export async function getMinPasswordLength(): Promise<number> {
  try {
    const config = await getWorkspaceConfig();
    const configured = config.workspace.minPasswordLength;
    if (Number.isFinite(configured) && configured >= ABSOLUTE_MIN_PASSWORD_LENGTH) {
      return Math.min(configured, 128);
    }
  } catch {
    // Config read failure must never block authentication flows — fall back.
  }
  return ABSOLUTE_MIN_PASSWORD_LENGTH;
}

/** Hash a password with the standard work factor. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/** Constant-time-ish comparison (bcrypt) against a stored hash. */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
