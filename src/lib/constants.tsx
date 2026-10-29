/**
 * Shared constants — single source of truth for dropdown options, accent
 * palettes, and other static data used across multiple components.
 *
 * Importing from here instead of redefining locally keeps every form in
 * the app in sync (e.g. adding a new timezone only needs to happen once).
 */

import { Leaf, Waves, Grape, Flame } from "lucide-react";
import type { AccentTheme } from "@/store/app-store";

// ---------------------------------------------------------------------------
// Accent color palette — used by avatar pickers, theme pickers, and the
// settings appearance section.
// ---------------------------------------------------------------------------

interface AccentDef {
  key: AccentTheme;
  label: string;
  /** OKLCH color string for inline styles. */
  color: string;
  icon: React.ComponentType<{ size?: number }>;
}

export const ACCENTS: AccentDef[] = [
  { key: "forest", label: "Forest", color: "oklch(0.55 0.13 152)", icon: Leaf },
  { key: "ocean", label: "Ocean", color: "oklch(0.55 0.13 220)", icon: Waves },
  { key: "plum", label: "Plum", color: "oklch(0.55 0.15 320)", icon: Grape },
  { key: "ember", label: "Ember", color: "oklch(0.60 0.15 35)", icon: Flame },
];

/** Project-only colors (includes "slate" which isn't an avatar theme). */
export const PROJECT_COLORS = ["forest", "ocean", "plum", "ember", "slate"] as const;

// ---------------------------------------------------------------------------
// Form option lists
// ---------------------------------------------------------------------------

export const TIMEZONES = [
  "Pacific/Auckland",
  "Australia/Sydney",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
] as const;

export const DEPARTMENTS = ["ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"] as const;

export const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;

export const TASK_TAGS = ["FRONTEND", "BACKEND", "DESIGN", "QA", "MARKETING"] as const;
