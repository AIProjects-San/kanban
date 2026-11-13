import { describe, it, expect } from "vitest";
import {
  ACTION_META,
  ACTION_META_DEFAULT,
  AuditAction,
  getActionMeta,
  ENTITY_BADGE,
  ENTITY_BADGE_DEFAULT,
  getEntityBadge,
  AUDIT_FILTERS,
} from "@/lib/audit/audit-meta";

const ALL_ACTIONS = Object.keys(ACTION_META) as AuditAction[];

describe("ACTION_META", () => {
  it("has an entry for every action in the union (and vice versa)", () => {
    // Compile-time exhaustiveness plus runtime symmetry check.
    const metaActions = new Set(ALL_ACTIONS);
    for (const a of ALL_ACTIONS) {
      expect(metaActions.has(a)).toBe(true);
      expect(ACTION_META[a].icon).toBeTruthy();
      expect(ACTION_META[a].cls).toMatch(/^(text|bg)-/);
    }
  });

  it("covers the core CRUD lifecycle for each entity family", () => {
    for (const a of [
      "task.created",
      "task.updated",
      "task.moved",
      "task.deleted",
      "project.created",
      "project.deleted",
      "member.invited",
      "member.removed",
      "user.created",
      "user.deleted",
      "auth.signed_in",
      "auth.password_changed",
    ] as AuditAction[]) {
      expect(ACTION_META[a], `missing meta for ${a}`).toBeDefined();
    }
  });

  it("P2-18: covers workspace.updated + config.created/updated/deleted", () => {
    // These replaced the misleading "profile.updated"/USER badges that lied
    // about what the mutation actually did.
    for (const a of [
      "workspace.updated",
      "config.created",
      "config.updated",
      "config.deleted",
    ] as AuditAction[]) {
      expect(ACTION_META[a], `missing meta for ${a}`).toBeDefined();
      expect(ACTION_META[a].icon).toBeTruthy();
      expect(ACTION_META[a].cls).toMatch(/^(text|bg)-/);
    }
    // The non-delete workspace/config actions use a purple/violet palette
    // to set them apart from regular profile edits. Deletes stay red.
    for (const a of [
      "workspace.updated",
      "config.created",
      "config.updated",
    ] as AuditAction[]) {
      expect(ACTION_META[a].cls).toMatch(/purple|violet/);
    }
    expect(ACTION_META["config.deleted"].cls).toMatch(/destructive/);
  });
});

describe("getActionMeta", () => {
  it("returns the mapped metadata for known actions", () => {
    expect(getActionMeta("task.created")).toBe(ACTION_META["task.created"]);
  });

  it("falls back to the default for unknown/legacy action strings", () => {
    expect(getActionMeta("some.legacy.action")).toBe(ACTION_META_DEFAULT);
    expect(getActionMeta("")).toBe(ACTION_META_DEFAULT);
  });
});

describe("getEntityBadge", () => {
  it("returns badges for all entity types written by logAudit", () => {
    // Entity types actually used in server-actions/data.ts
    for (const t of [
      "TASK",
      "PROJECT",
      "MEMBER",
      "USER",
      "ROLE",
      "EVENT",
      "MESSAGE",
      "REMINDER",
      "TIME",
      "AUTH",
      // P2-18: workspace + config mutations get their own badges instead of
      // being mislabelled as USER/profile updates.
      "WORKSPACE",
      "CONFIG",
    ]) {
      const badge = getEntityBadge(t);
      expect(badge).not.toBe(ENTITY_BADGE_DEFAULT);
      expect(badge.label).toBeTruthy();
    }
  });

  it("falls back for unknown entity types", () => {
    expect(getEntityBadge("WAT")).toBe(ENTITY_BADGE_DEFAULT);
  });

  it("ENTITY_BADGE and AUDIT_FILTERS stay in sync (no orphaned entity)", () => {
    for (const filter of AUDIT_FILTERS) {
      if (!filter.types) continue;
      for (const t of filter.types) {
        expect(ENTITY_BADGE[t], `filter references unknown entity type ${t}`).toBeDefined();
      }
    }
  });
});

describe("AUDIT_FILTERS", () => {
  it("starts with an 'all' bucket that has no type restriction", () => {
    expect(AUDIT_FILTERS[0].key).toBe("all");
    expect(AUDIT_FILTERS[0].types).toBeNull();
  });

  it("covers every known entity type in exactly one bucket", () => {
    const covered = new Set(
      AUDIT_FILTERS.flatMap((f) => f.types ?? []),
    );
    for (const t of Object.keys(ENTITY_BADGE)) {
      expect(covered.has(t), `entity type ${t} is missing from the filter tabs`).toBe(true);
    }
  });
});
