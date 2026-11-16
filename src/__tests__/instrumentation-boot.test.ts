import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// R-P0-6 (REVIEW_TRIAGE §4.5-6) — production startup posture for
// SERVER_ACTIONS_ALLOWED_ORIGINS. The corrected R-P0 batch specification:
// WARN, never block. (The earlier P1 guard made an unset value FATAL; that
// posture is re-specified — the production DEFAULT itself became
// same-origin-only in next.config.ts / auth-better.ts, so unset is SAFE,
// merely likely-misconfigured behind a proxy, and a warning is the honest
// severity.)
//
//   • prod + unset          → warning logged, startup SUCCEEDS
//   • prod + trust-all "*"  → LOUD warning, startup SUCCEEDS
//   • prod + specific list  → no warning, startup succeeds
//   • dev + unset           → no warning (dev behavior unchanged)
//   • prod + malformed entry (a typo, not a posture) → still fatal
// ---------------------------------------------------------------------------

async function importRegister(): Promise<() => Promise<void>> {
  const mod = await import("../instrumentation-node");
  return mod.register;
}

describe("R-P0-6 — boot posture: origins warnings never block startup", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // CRITICAL: a regression back to process.exit(1) must fail the test,
    // not kill the runner.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prod + unset → warning logged, startup succeeds (no exit)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_ACTIONS_ALLOWED_ORIGINS", "");
    const register = await importRegister();
    await expect(register()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SERVER_ACTIONS_ALLOWED_ORIGINS is unset in production"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Startup continues"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prod + the trust-all '*' → LOUD warning (console.error), startup succeeds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_ACTIONS_ALLOWED_ORIGINS", "*");
    const register = await importRegister();
    await expect(register()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("trust-all wildcard '*'"),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("does not block the boot"),
    );
    // NOT the unset warning — the env is set.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prod + a specific list → no warning at all, startup succeeds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_ACTIONS_ALLOWED_ORIGINS", "https://app.example.com,staging.example.com");
    const register = await importRegister();
    await expect(register()).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("[boot]"));
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("dev + unset → no warning (dev behavior unchanged)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SERVER_ACTIONS_ALLOWED_ORIGINS", "");
    const register = await importRegister();
    await expect(register()).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prod + a malformed entry (a typo, not a posture) → still fatal", async () => {
    // Unchanged P2 behavior, pinned: garbage in the origin list is a
    // config mistake, and failing fast is correct for a mistake.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_ACTIONS_ALLOWED_ORIGINS", "https://app.example.com,garbage");
    const register = await importRegister();
    await expect(register()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid SERVER_ACTIONS_ALLOWED_ORIGINS: garbage"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
