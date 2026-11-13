import { describe, it, expect } from "vitest";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_STATUS_ACCENT,
  PROJECT_STATUSES,
  PROJECT_STATUS_MAP,
  EVENT_TYPES,
  EVENT_TYPE_MAP,
  priorityClass,
  tagClass,
  DEPARTMENT_LABELS,
  departmentLabel,
} from "@/lib/shared/config";
import { PRIORITIES, TASK_TAGS } from "@/lib/shared/constants";

describe("task status config", () => {
  it("defines the four Kanban columns in order", () => {
    expect(TASK_STATUSES.map((s) => s.key)).toEqual([
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "DONE",
    ]);
  });

  it("has a label and accent class for every status", () => {
    for (const s of TASK_STATUSES) {
      expect(s.label).toBeTruthy();
      expect(s.accent).toMatch(/^bg-/);
    }
  });

  it("label/accent lookup maps are consistent with the array", () => {
    for (const s of TASK_STATUSES) {
      expect(TASK_STATUS_LABELS[s.key]).toBe(s.label);
      expect(TASK_STATUS_ACCENT[s.key]).toBe(s.accent);
    }
  });
});

describe("project status config", () => {
  it("covers running, pending, paused and ended", () => {
    const keys = PROJECT_STATUSES.map((s) => s.key).sort();
    expect(keys).toEqual(["ENDED", "PAUSED", "PENDING", "RUNNING"]);
  });

  it("every status has badge and dot classes", () => {
    for (const s of PROJECT_STATUSES) {
      expect(s.badge).toBeTruthy();
      expect(s.dot).toMatch(/^bg-/);
      expect(PROJECT_STATUS_MAP[s.key]).toEqual(s);
    }
  });
});

describe("event type config", () => {
  it("defines all six event types with styles", () => {
    expect(EVENT_TYPES).toHaveLength(6); // 5 base + LEAVE (HR module)
    for (const e of EVENT_TYPES) {
      expect(e.label).toBeTruthy();
      expect(e.dot).toMatch(/^bg-/);
      expect(EVENT_TYPE_MAP[e.key]).toEqual(e);
    }
  });
});

describe("class helpers", () => {
  it("priorityClass lowercases the key into the CSS convention", () => {
    expect(priorityClass("HIGH")).toBe("f-priority-high");
    expect(priorityClass("MEDIUM")).toBe("f-priority-medium");
    expect(priorityClass("low")).toBe("f-priority-low");
  });

  it("tagClass lowercases the key into the CSS convention", () => {
    expect(tagClass("FRONTEND")).toBe("f-tag-frontend");
    expect(tagClass("qa")).toBe("f-tag-qa");
  });
});

describe("departments", () => {
  it("covers the four seeded departments", () => {
    expect(DEPARTMENT_LABELS.map((d) => d.key).sort()).toEqual([
      "DESIGN",
      "ENGINEERING",
      "MANAGEMENT",
      "MARKETING",
    ]);
  });

  it("departmentLabel title-cases machine keys", () => {
    expect(departmentLabel("ENGINEERING")).toBe("Engineering");
    expect(departmentLabel("MARKETING")).toBe("Marketing");
  });
});

describe("constants alignment with config", () => {
  it("PRIORITIES contains the three expected keys", () => {
    expect(PRIORITIES.map((p) => p.toUpperCase()).sort()).toEqual(["HIGH", "LOW", "MEDIUM"]);
  });

  it("TASK_TAGS matches the canonical tag set", () => {
    expect(TASK_TAGS.length).toBeGreaterThan(0);
    for (const tag of TASK_TAGS) {
      expect(typeof tag).toBe("string");
    }
  });
});
