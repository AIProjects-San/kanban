import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — next-auth/react's signOut + window.location.replace.
// ---------------------------------------------------------------------------

const signOutMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());

vi.mock("next-auth/react", () => ({
  signOut: signOutMock,
}));

import { appSignOut } from "@/lib/signout";

describe("appSignOut", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    signOutMock.mockReset();
    signOutMock.mockResolvedValue({ url: "http://localhost/" });
    // Install a minimal window stub so the "use client" helper can call
    // window.location.replace without a real DOM.
    (globalThis as Record<string, unknown>).window = {
      location: { replace: replaceMock },
    };
    replaceMock.mockReset();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });

  it("calls next-auth signOut with callbackUrl=/ and redirect:true", async () => {
    await appSignOut();
    expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: "/", redirect: true });
  });

  it("falls through to window.location.replace('/') on the success path too (belt-and-braces)", async () => {
    await appSignOut();
    expect(replaceMock).toHaveBeenCalledWith("/");
  });

  it("still navigates to / when signOut throws (network error / server hiccup)", async () => {
    signOutMock.mockRejectedValue(new Error("network down"));
    await appSignOut();
    expect(replaceMock).toHaveBeenCalledWith("/");
  });

  it("does NOT throw when signOut throws — the catch swallows it", async () => {
    signOutMock.mockRejectedValue(new Error("boom"));
    await expect(appSignOut()).resolves.toBeUndefined();
  });

  it("skips window.location.replace when window is undefined (SSR safety)", async () => {
    delete (globalThis as Record<string, unknown>).window;
    await expect(appSignOut()).resolves.toBeUndefined();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
