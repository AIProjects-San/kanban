-- PR-65 — per-user appearance. The sidebar rail (compact icon-only layout)
-- was persisted only in the browser's localStorage, which is shared by every
-- account using that browser — one user's density choice applied to all of
-- them (same class of bug as the accent/dark theme). It is now a per-user
-- column on UserSettings, exactly like accent/dark.

ALTER TABLE "UserSettings" ADD COLUMN "sidebarRail" BOOLEAN NOT NULL DEFAULT false;
