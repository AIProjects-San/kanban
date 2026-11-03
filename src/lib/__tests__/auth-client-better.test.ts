import { describe, it, expect, vi } from "vitest";

// PR-56 — auth-client-better.ts is the browser-side Better Auth client
// wrapper. It had 0% coverage because no unit test imports it (it's only
// pulled into the client bundle by use-app-session.ts). A smoke test pins
// the contract the wrappers rely on: the mounted basePath matches the
// server route. Args are recorded in a plain hoisted array inside the mock
// factory (a module-scope vi.fn's call log is wiped by the time the first
// test asserts, since the import runs during file evaluation).

const recorder = vi.hoisted(() => ({
  calls: [] as Array<Array<unknown>>,
  result: { marker: "mock-client" },
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: (...args: unknown[]) => {
    recorder.calls.push(args);
    return recorder.result;
  },
}));

const { authClient } = await import("@/lib/auth-client-better");

describe("auth-client-better (browser client wrapper)", () => {
  it("creates the client at module load with the server-matching basePath", () => {
    expect(recorder.calls.length).toBe(1);
    expect(recorder.calls[0][0]).toEqual({ basePath: "/api/auth-better" });
    // The exported client IS the one the factory returned.
    expect(authClient).toBe(recorder.result);
  });
});
