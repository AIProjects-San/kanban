// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-65 — per-user appearance in the app store.
//
// The three flat localStorage keys (accent/dark/rail) were one shared set per
// browser, so one account's appearance leaked into every other account on
// that machine. They are now ONE blob tagged with the owning user id, which
// AppShell rebinds via applyUserAppearance on every mount (DB row = source
// of truth). Legacy flat keys are deleted at boot so stale values can never
// resurface.
// ---------------------------------------------------------------------------

import { useApp, type AccentTheme } from "@/store/app-store";
import { STORAGE_KEYS, LEGACY_STORAGE_KEYS } from "@/config/app";

describe("applyUserAppearance (PR-65 per-user binding)", () => {
  beforeEach(() => {
    localStorage.clear();
    useApp.setState({ themeUserId: null });
  });

  it("applies the user's DB-backed appearance and rebinds the cache to them", () => {
    useApp.getState().applyUserAppearance({
      userId: "u-1",
      accent: "plum" as AccentTheme,
      dark: true,
      rail: true,
    });

    const s = useApp.getState();
    expect(s.themeUserId).toBe("u-1");
    expect(s.accent).toBe("plum");
    expect(s.dark).toBe(true);
    expect(s.sidebarRail).toBe(true);
    // Document attributes follow (the actual theming surface).
    expect(document.documentElement.getAttribute("data-accent")).toBe("plum");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // The cache blob is tagged with the owning user.
    const blob = JSON.parse(localStorage.getItem(STORAGE_KEYS.theme) ?? "{}");
    expect(blob).toEqual({ userId: "u-1", accent: "plum", dark: true, rail: true });
  });

  it("switching to another user replaces their appearance entirely (no residue)", () => {
    useApp.getState().applyUserAppearance({
      userId: "u-1", accent: "plum" as AccentTheme, dark: true, rail: true,
    });
    // User 2 logs in on the same browser with default settings.
    useApp.getState().applyUserAppearance({
      userId: "u-2", accent: "forest" as AccentTheme, dark: false, rail: false,
    });

    const s = useApp.getState();
    expect(s.themeUserId).toBe("u-2");
    expect(s.accent).toBe("forest");
    expect(s.dark).toBe(false);
    expect(s.sidebarRail).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    const blob = JSON.parse(localStorage.getItem(STORAGE_KEYS.theme) ?? "{}");
    expect(blob).toEqual({ userId: "u-2", accent: "forest", dark: false, rail: false });
  });
});

describe("theme setters write through to the per-user cache", () => {
  beforeEach(() => {
    localStorage.clear();
    useApp.getState().applyUserAppearance({
      userId: "u-1", accent: "forest" as AccentTheme, dark: false, rail: false,
    });
  });

  it("setAccent / setDark / toggleSidebarRail keep the cache bound to the same user", () => {
    useApp.getState().setAccent("ocean" as AccentTheme);
    useApp.getState().setDark(true);
    useApp.getState().toggleSidebarRail();

    const blob = JSON.parse(localStorage.getItem(STORAGE_KEYS.theme) ?? "{}");
    // The values changed — but the OWNING USER did not (the old bug: these
    // were shared flat keys, so the change applied to every account).
    expect(blob).toEqual({ userId: "u-1", accent: "ocean", dark: true, rail: true });
    expect(useApp.getState().themeUserId).toBe("u-1");
  });
});

describe("legacy shared keys never resurface", () => {
  it("the PR-65 migration list covers the old flat keys", () => {
    // loadInitial deletes these at boot; pin the list so a future rename of
    // STORAGE_KEYS can't silently strand the old keys in users' browsers.
    expect(LEGACY_STORAGE_KEYS).toEqual([
      "fernly-accent",
      "fernly-dark",
      "fernly-rail",
    ]);
    expect(STORAGE_KEYS.theme).toBe("fernly-theme");
  });
});
