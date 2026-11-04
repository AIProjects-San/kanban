-- PR-65 — revert per-user sidebar rail.
ALTER TABLE "UserSettings" DROP COLUMN "sidebarRail";
