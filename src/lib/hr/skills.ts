// ---------------------------------------------------------------------------
// P37 (EM-19, PF-07, EM-18) — the skill master + employee skill maps
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P37). Pure so both
// sides import it: the server actions' guards and the UI's rendering.
//
//   • EM-19/PF-07 — the SHARED master (Skill rows keyed like
//     DocumentTypeConfig; the interview round-template epic later joins on
//     the same key).
//   • EM-18 — the per-employee map (EmployeeSkill rows, rating 1–5).
//
// The proficiency vocabulary (the benchmark's Employee Skill ratings):
//   1 Learning · 2 Developing · 3 Solid · 4 Advanced · 5 Expert
// ---------------------------------------------------------------------------

export const SKILL_RATING_MIN = 1;
export const SKILL_RATING_MAX = 5;

export const SKILL_PROFICIENCY_LABELS: Record<number, string> = {
  1: "Learning",
  2: "Developing",
  3: "Solid",
  4: "Advanced",
  5: "Expert",
};

export function skillProficiencyLabel(rating: number): string {
  return SKILL_PROFICIENCY_LABELS[Math.round(rating)] ?? `Rating ${rating}`;
}

export interface SkillRow {
  key: string;
  label: string;
  isActive: boolean;
}

export interface SkillMapEntry {
  skillKey: string;
  label: string;
  rating: number;
}

/** The map's one-line summary the profile card shows:
 *  "4 skills · avg 3.5 (Solid)" — the honest empty when none. */
export function skillMapSummary(
  entries: Array<{ rating: number }>,
): { count: number; average: number | null; summary: string } {
  const count = entries.length;
  if (count === 0) return { count: 0, average: null, summary: "no rated skills yet" };
  const average = Math.round((entries.reduce((s, e) => s + e.rating, 0) / count) * 10) / 10;
  return {
    count,
    average,
    summary: `${count} skill${count === 1 ? "" : "s"} · avg ${average} (${skillProficiencyLabel(Math.round(average))})`,
  };
}

/** The top-rated subset the card highlights: rating >= 4, rating-desc,
 *  label-asc for determinism. Empty array when none reach the bar. */
export function topSkills(
  entries: SkillMapEntry[],
  bar = 4,
): SkillMapEntry[] {
  return entries
    .filter((e) => e.rating >= bar)
    .sort((a, b) => b.rating - a.rating || a.label.localeCompare(b.label));
}

/** May a rating be written? Integer 1..5 (zod twin — the pure guard for
 *  tests and any non-zod caller). */
export function isValidSkillRating(rating: number): boolean {
  return Number.isInteger(rating) && rating >= SKILL_RATING_MIN && rating <= SKILL_RATING_MAX;
}
