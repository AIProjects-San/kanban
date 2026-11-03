import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// PR-31 (production-readiness round 2) — mock the Redis surface so the
// pub/sub invalidation tests can capture the subscriber callback and
// observe publishes. Defaults keep the existing suites on the pure
// in-memory path (publisher undefined, subscriber disabled).
// ---------------------------------------------------------------------------

const redisMocks = vi.hoisted(() => {
  const state = {
    publish: vi.fn(async () => 1),
    publisherEnabled: false,
    subscriberEnabled: false,
    subscriberThrows: false,
    onMessage: null as null | ((m: string) => void),
    subscribeCalls: 0,
  };
  return state;
});

vi.mock("@/lib/redis-client", () => ({
  getSharedRedisClient: vi.fn(() => undefined),
  redisKeyPrefix: () => "app:",
  configInvalidationChannel: () => "app:config:invalidate",
  getSharedRedisPublisher: () =>
    redisMocks.publisherEnabled ? { publish: redisMocks.publish } : undefined,
  subscribeToConfigInvalidation: (cb: (m: string) => void) => {
    redisMocks.subscribeCalls += 1;
    if (redisMocks.subscriberThrows) {
      throw new Error("subscriber construction failed");
    }
    if (!redisMocks.subscriberEnabled) return undefined;
    redisMocks.onMessage = cb;
    return { unsubscribe: () => undefined };
  },
}));

// ---------------------------------------------------------------------------
// Mock the Prisma client BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const { findFirst, findMany } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workspace: { findFirst },
    taskStatusConfig: { findMany },
    projectStatusConfig: { findMany },
    eventTypeConfig: { findMany },
    taskTagConfig: { findMany },
    priorityConfig: { findMany },
    departmentConfig: { findMany },
    role: { findMany },
    permission: { findMany },
    rolePermission: { findMany },
  },
}));

import {
  getWorkspaceConfig,
  hasPermissionDb,
  bumpConfigCache,
  _resetConfigCacheForTests,
} from "@/lib/config-loader";

function stubEmptyTables() {
  findFirst.mockResolvedValue(null);
  findMany.mockResolvedValue([]);
}

describe("getWorkspaceConfig — fallbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bumpConfigCache();
    stubEmptyTables();
  });

  it("returns code defaults when every table is empty", async () => {
    const config = await getWorkspaceConfig();
    expect(config.workspace.name).toBe("Fernly Workspace");
    expect(config.workspace.minPasswordLength).toBe(8);
    expect(config.taskStatuses).toHaveLength(4);
    expect(config.projectStatuses).toHaveLength(4);
    expect(config.eventTypes).toHaveLength(6); // 5 base + LEAVE (HR module)
    expect(config.departments).toHaveLength(4);
  });

  it("derives fallback roles from the hardcoded RBAC matrix", async () => {
    const config = await getWorkspaceConfig();
    const keys = config.roles.map((r) => r.key);
    expect(keys).toContain("ADMIN");
    expect(keys).toContain("MANAGER");
    expect(keys).toContain("MEMBER");
    const admin = config.roles.find((r) => r.key === "ADMIN")!;
    expect(admin.permissions).toContain("role:manage");
    expect(admin.isSystem).toBe(true);
  });

  it("marks DONE as the only terminal fallback task status", async () => {
    const config = await getWorkspaceConfig();
    const terminal = config.taskStatuses.filter((s) => s.isTerminal);
    expect(terminal.map((s) => s.key)).toEqual(["DONE"]);
  });
});

describe("getWorkspaceConfig — DB-driven values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bumpConfigCache();
  });

  it("uses DB rows when present", async () => {
    findFirst.mockResolvedValue({
      name: "Acme Inc",
      defaultTimezone: "Europe/Berlin",
      defaultUserRole: "MEMBER",
      defaultDepartment: "DESIGN",
      defaultAvatarColor: "ocean",
      defaultJobTitle: "Designer",
      minPasswordLength: 12,
      workloadFullCapacity: 5,
      auditLogLimit: 100,
      entityHistoryLimit: 25,
      dashboardNotifLimit: 10,
    });
    findMany.mockResolvedValue([]);
    const config = await getWorkspaceConfig();
    expect(config.workspace.name).toBe("Acme Inc");
    expect(config.workspace.minPasswordLength).toBe(12);
  });

  it("maps task status rows including custom statuses", async () => {
    findFirst.mockResolvedValue(null);
    // The first findMany call is taskStatusConfig (see getWorkspaceConfig).
    let call = 0;
    findMany.mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve([
          { key: "BLOCKED", label: "Blocked", accentClass: "bg-red-500", sortOrder: 0, isTerminal: false },
        ]);
      }
      return Promise.resolve([]);
    });
    const config = await getWorkspaceConfig();
    expect(config.taskStatuses.map((s) => s.key)).toEqual(["BLOCKED"]);
    expect(config.taskStatuses[0].isTerminal).toBe(false);
  });

  it("maps every config family when the DB is fully populated", async () => {
    findFirst.mockResolvedValue(null);
    let call = 0;
    findMany.mockImplementation(() => {
      call++;
      switch (call) {
        case 1: // taskStatusConfig
          return Promise.resolve([
            { key: "TODO", label: "To do", accentClass: "bg-zinc-400", sortOrder: 0, isTerminal: false },
            { key: "DONE", label: "Done", accentClass: "bg-emerald-500", sortOrder: 1, isTerminal: true },
          ]);
        case 2: // projectStatusConfig
          return Promise.resolve([
            { key: "RUNNING", label: "Running", badgeClass: "b", dotClass: "d", sortOrder: 0 },
          ]);
        case 3: // eventTypeConfig
          return Promise.resolve([
            { key: "MEETING", label: "Meeting", dotClass: "d", bgClass: "g", sortOrder: 0 },
          ]);
        case 4: // taskTagConfig
          return Promise.resolve([
            { key: "FRONTEND", label: "Frontend", color: "oklch(0.5 0.1 200)", sortOrder: 0 },
          ]);
        case 5: // priorityConfig
          return Promise.resolve([
            { key: "HIGH", label: "High", color: "oklch(0.6 0.2 20)", sortOrder: 0 },
          ]);
        case 6: // departmentConfig
          return Promise.resolve([
            { key: "ENGINEERING", label: "Engineering", sortOrder: 0 },
          ]);
        case 7: // role (with nested permissions)
          return Promise.resolve([
            {
              id: "r-1", key: "MEMBER", label: "Member", description: "d",
              iconName: "Shield", badgeClass: "b", isSystem: true, sortOrder: 0,
              permissions: [
                { permission: { key: "task:create" } },
                { permission: { key: "task:edit:own" } },
              ],
            },
          ]);
        case 8: // permission
          return Promise.resolve([
            { key: "task:create", label: "Create tasks", description: "d", group: "Tasks" },
          ]);
        default: // rolePermission
          return Promise.resolve([]);
      }
    });

    const config = await getWorkspaceConfig();
    expect(config.taskStatuses.map((s) => [s.key, s.isTerminal])).toEqual([
      ["TODO", false],
      ["DONE", true],
    ]);
    expect(config.projectStatuses[0]).toMatchObject({ key: "RUNNING", badgeClass: "b" });
    expect(config.eventTypes[0]).toMatchObject({ key: "MEETING", bgClass: "g" });
    expect(config.taskTags[0]).toMatchObject({ key: "FRONTEND", color: "oklch(0.5 0.1 200)" });
    expect(config.priorities[0]).toMatchObject({ key: "HIGH" });
    expect(config.departments[0]).toMatchObject({ key: "ENGINEERING", label: "Engineering" });
    expect(config.roles[0]).toMatchObject({
      key: "MEMBER",
      permissions: ["task:create", "task:edit:own"],
    });
    expect(config.permissions[0]).toMatchObject({ key: "task:create", group: "Tasks" });

    // hasPermissionDb now honours the DB-driven permission set.
    expect(await hasPermissionDb("MEMBER", "task:create")).toBe(true);
    expect(await hasPermissionDb("MEMBER", "role:manage")).toBe(false);
  });
});

describe("getWorkspaceConfig — caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bumpConfigCache();
    stubEmptyTables();
  });

  it("caches the result and skips DB round trips within the TTL", async () => {
    await getWorkspaceConfig();
    await getWorkspaceConfig();
    await getWorkspaceConfig();
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("re-reads the DB after bumpConfigCache()", async () => {
    await getWorkspaceConfig();
    bumpConfigCache();
    await getWorkspaceConfig();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});

describe("hasPermissionDb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bumpConfigCache();
    stubEmptyTables();
  });

  it("falls back to the hardcoded matrix for known roles", async () => {
    expect(await hasPermissionDb("ADMIN", "role:manage")).toBe(true);
    expect(await hasPermissionDb("MEMBER", "role:manage")).toBe(false);
    expect(await hasPermissionDb("MEMBER", "task:edit:own")).toBe(true);
  });

  it("returns false for unknown roles", async () => {
    expect(await hasPermissionDb("SUPERUSER", "task:create")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PR-31 (production-readiness round 2) — cross-instance cache invalidation
// over Redis pub/sub. Roadmap §6.10: with 2 replicas, instance B only saw
// instance A's config mutation after the 10 s TTL. Now bumpConfigCache
// publishes on a channel and every instance's subscriber clears its local
// cache on the message.
// ---------------------------------------------------------------------------

describe("cross-instance config invalidation (PR-31)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetConfigCacheForTests();
    stubEmptyTables();
    redisMocks.publish.mockClear();
    redisMocks.publisherEnabled = false;
    redisMocks.subscriberEnabled = false;
    redisMocks.onMessage = null;
    redisMocks.subscribeCalls = 0;
  });

  it("bumpConfigCache publishes an invalidation message when Redis is configured", async () => {
    redisMocks.publisherEnabled = true;
    bumpConfigCache();
    // The publish rides along asynchronously (bump stays sync for callers).
    await new Promise((r) => setTimeout(r, 0));
    expect(redisMocks.publish).toHaveBeenCalledWith(
      "app:config:invalidate",
      expect.stringMatching(/^bump:/),
    );
  });

  it("bumpConfigCache stays a local-only clear when Redis is not configured", async () => {
    bumpConfigCache();
    await new Promise((r) => setTimeout(r, 0));
    expect(redisMocks.publish).not.toHaveBeenCalled();
  });

  it("a publish failure never breaks the mutating server action", async () => {
    redisMocks.publisherEnabled = true;
    redisMocks.publish.mockRejectedValue(new Error("redis gone"));
    expect(() => bumpConfigCache()).not.toThrow();
    // Flush the rejected promise — the catch inside must swallow it.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("a pub/sub message from another instance clears the cached config", async () => {
    redisMocks.subscriberEnabled = true;
    await getWorkspaceConfig(); // starts the subscriber + caches
    expect(redisMocks.subscribeCalls).toBe(1);
    expect(redisMocks.onMessage).toBeTypeOf("function");

    await getWorkspaceConfig(); // served from cache — no new DB read
    expect(findFirst).toHaveBeenCalledTimes(1);

    // Instance A mutated config and published — our cache must drop now.
    redisMocks.onMessage!("bump:other-instance:1");
    await getWorkspaceConfig();
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("starts the subscriber exactly once per process", async () => {
    redisMocks.subscriberEnabled = true;
    await getWorkspaceConfig();
    await getWorkspaceConfig();
    await getWorkspaceConfig();
    expect(redisMocks.subscribeCalls).toBe(1);
  });

  it("without a subscriber handle (Redis unavailable) the TTL still governs", async () => {
    await getWorkspaceConfig();
    await getWorkspaceConfig();
    expect(findFirst).toHaveBeenCalledTimes(1);
    // No pub/sub message can arrive; nothing throws, cache holds.
    expect(redisMocks.onMessage).toBeNull();
  });

  it("PR-56: a throwing subscriber start degrades to the TTL backstop (never 500s)", async () => {
    // The invalidation subscriber's constructor throwing must be swallowed:
    // config reads still succeed and the 10s TTL remains the backstop.
    // (logWarn emits a JSON line via console.error — see structuredLog.)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    redisMocks.subscriberThrows = true;
    try {
      const config = await getWorkspaceConfig();
      expect(config.workspace.name).toBe("Fernly Workspace");
      // The failure was visible in the log with the TTL note.
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("failed to start the invalidation subscriber");
      expect(logged).toContain("TTL backstop applies");
      expect(logged).toContain("subscriber construction failed");
      // And the next read still works (cache, no crash loop).
      await getWorkspaceConfig();
      expect(findFirst).toHaveBeenCalledTimes(1);
    } finally {
      redisMocks.subscriberThrows = false;
      errSpy.mockRestore();
    }
  });
});
