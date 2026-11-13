import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P37 (EM-19, PF-07, EM-18) — the skill kernel (lib/skills.ts): the
// proficiency vocabulary, the map summary and the top-skills subset.
// ---------------------------------------------------------------------------

import {
  SKILL_PROFICIENCY_LABELS,
  skillProficiencyLabel,
  skillMapSummary,
  topSkills,
  isValidSkillRating,
} from "@/lib/hr/skills";

describe("the proficiency vocabulary", () => {
  it("maps every rating 1-5 to its label", () => {
    expect(SKILL_PROFICIENCY_LABELS[1]).toBe("Learning");
    expect(SKILL_PROFICIENCY_LABELS[2]).toBe("Developing");
    expect(SKILL_PROFICIENCY_LABELS[3]).toBe("Solid");
    expect(SKILL_PROFICIENCY_LABELS[4]).toBe("Advanced");
    expect(SKILL_PROFICIENCY_LABELS[5]).toBe("Expert");
  });

  it("rounds before lookup; unknown ratings render honestly", () => {
    expect(skillProficiencyLabel(4.67)).toBe("Expert"); // 4.67 → 5
    expect(skillProficiencyLabel(4.4)).toBe("Advanced"); // 4.4 → 4
    expect(skillProficiencyLabel(2.4)).toBe("Developing");
    expect(skillProficiencyLabel(9)).toBe("Rating 9");
  });
});

describe("skillMapSummary", () => {
  it("the honest empty when no rated skills", () => {
    expect(skillMapSummary([])).toEqual({ count: 0, average: null, summary: "no rated skills yet" });
  });

  it("one skill: '1 skill · avg 5 (Expert)'", () => {
    expect(skillMapSummary([{ rating: 5 }]).summary).toBe("1 skill · avg 5 (Expert)");
  });

  it("the average rounds to one decimal (14/3 → 4.7)", () => {
    const out = skillMapSummary([{ rating: 5 }, { rating: 4 }, { rating: 5 }]);
    expect(out).toEqual({ count: 3, average: 4.7, summary: "3 skills · avg 4.7 (Expert)" });
  });
});

describe("topSkills", () => {
  const entries = [
    { skillKey: "react", label: "React", rating: 5 },
    { skillKey: "typescript", label: "TypeScript", rating: 4 },
    { skillKey: "design_systems", label: "Design Systems", rating: 5 },
    { skillKey: "user_research", label: "User Research", rating: 3 },
  ];

  it("returns only entries at/above the bar, rating-desc then label-asc", () => {
    expect(topSkills(entries).map((e) => e.label)).toEqual(["Design Systems", "React", "TypeScript"]);
  });

  it("a custom bar moves the subset; an empty result when nothing reaches it", () => {
    expect(topSkills(entries, 5).map((e) => e.label)).toEqual(["Design Systems", "React"]);
    expect(topSkills([{ skillKey: "x", label: "X", rating: 2 }], 4)).toEqual([]);
  });
});

describe("isValidSkillRating", () => {
  it("integer 1..5 only", () => {
    for (const r of [1, 2, 3, 4, 5]) expect(isValidSkillRating(r)).toBe(true);
    for (const r of [0, 6, 3.5, -1, NaN]) expect(isValidSkillRating(r)).toBe(false);
  });
});
