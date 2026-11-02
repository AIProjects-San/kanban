import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// Mocks — config loader so we can exercise both branches of getMinPasswordLength.
// ---------------------------------------------------------------------------

const { getWorkspaceConfig } = vi.hoisted(() => ({
  getWorkspaceConfig: vi.fn(),
}));
vi.mock("@/lib/config-loader", () => ({ getWorkspaceConfig }));

import {
  BCRYPT_COST,
  ABSOLUTE_MIN_PASSWORD_LENGTH,
  getMinPasswordLength,
  hashPassword,
  verifyPassword,
} from "@/lib/password";

describe("password policy constants (P2-19)", () => {
  it("BCRYPT_COST is 12 (upgraded from the original 10)", () => {
    // 12 ≈ 250ms/hash on 2025-era hardware — deliberate slowdown for attackers.
    expect(BCRYPT_COST).toBe(12);
  });

  it("ABSOLUTE_MIN_PASSWORD_LENGTH floor is 8 (workspace cannot lower it)", () => {
    expect(ABSOLUTE_MIN_PASSWORD_LENGTH).toBe(8);
  });
});

describe("getMinPasswordLength — workspace-configurable with floor (P2-19)", () => {
  beforeEach(() => {
    getWorkspaceConfig.mockReset();
  });

  it("returns the workspace-configured value when >= 8", async () => {
    getWorkspaceConfig.mockResolvedValue({
      workspace: { minPasswordLength: 12 },
    });
    expect(await getMinPasswordLength()).toBe(12);
  });

  it("returns the workspace-configured value when 8 exactly (boundary)", async () => {
    getWorkspaceConfig.mockResolvedValue({
      workspace: { minPasswordLength: 8 },
    });
    expect(await getMinPasswordLength()).toBe(8);
  });

  it("falls back to 8 when the workspace value is below the floor", async () => {
    // A workspace admin cannot weaken the policy below 8.
    getWorkspaceConfig.mockResolvedValue({
      workspace: { minPasswordLength: 4 },
    });
    expect(await getMinPasswordLength()).toBe(8);
  });

  it("falls back to 8 when the workspace value is non-numeric garbage", async () => {
    getWorkspaceConfig.mockResolvedValue({
      workspace: { minPasswordLength: "lots" as unknown as number },
    });
    expect(await getMinPasswordLength()).toBe(8);
  });

  it("falls back to 8 when the config table is empty", async () => {
    getWorkspaceConfig.mockResolvedValue({
      workspace: { minPasswordLength: 0 },
    });
    expect(await getMinPasswordLength()).toBe(8);
  });

  it("falls back to 8 when getWorkspaceConfig throws (config read failure must not block auth)", async () => {
    getWorkspaceConfig.mockRejectedValue(new Error("db down"));
    expect(await getMinPasswordLength()).toBe(8);
  });

  it("caps the configured value at 128 (no pathological 1_000_000 lengths)", async () => {
    getWorkspaceConfig.mockResolvedValue({
      workspace: { minPasswordLength: 1_000_000 },
    });
    expect(await getMinPasswordLength()).toBe(128);
  });
});

describe("hashPassword / verifyPassword — bcrypt round-trip", () => {
  it("hashes with the documented BCRYPT_COST", async () => {
    const hash = await hashPassword("correct-horse-1");
    // bcrypt hashes embed the cost as `$<cost>$` near the start.
    expect(hash).toMatch(new RegExp(`^\\$2[ab]\\$${BCRYPT_COST}\\$`));
  });

  it("verifyPassword returns true for the right password", async () => {
    const hash = await hashPassword("correct-horse-1");
    expect(await verifyPassword("correct-horse-1", hash)).toBe(true);
  });

  it("verifyPassword returns false for the wrong password", async () => {
    const hash = await hashPassword("correct-horse-1");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("hashes are salted — same password produces different hashes", async () => {
    const a = await hashPassword("same-password-1");
    const b = await hashPassword("same-password-1");
    expect(a).not.toBe(b);
    // But both verify against the same plain password.
    expect(await verifyPassword("same-password-1", a)).toBe(true);
    expect(await verifyPassword("same-password-1", b)).toBe(true);
  });
});

// Reference bcrypt to silence unused-import warnings in strict lint.
void bcrypt;
