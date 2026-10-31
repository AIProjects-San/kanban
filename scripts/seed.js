/* eslint-disable @typescript-eslint/no-require-imports */
// Fernly seed script — generates rich, realistic mock data
// Run: bun run db:seed

// ---------------------------------------------------------------------------
// L-P0-12 — seed safety guard. MUST run BEFORE any require() that could
// load .env (notably @prisma/client, which sources .env at import time).
//
// Requires an EXPLICIT `SEED_DEMO=1` env var, independent of NODE_ENV:
//   - `NODE_ENV=production bun run db:seed`              → refused (production)
//   - `bun run db:seed`                                  → refused (no SEED_DEMO)
//   - `SEED_DEMO=1 bun run db:seed`                      → allowed (demo dev)
//   - `SEED_DEMO=1 NODE_ENV=production bun run db:seed`  → refused (production)
//
// We snapshot the env vars NOW, before Prisma loads .env. Otherwise a .env
// containing SEED_DEMO=1 would silently bypass this guard.
// ---------------------------------------------------------------------------
const SEED_DEMO_AT_BOOT = process.env.SEED_DEMO;
const NODE_ENV_AT_BOOT = process.env.NODE_ENV;

if (NODE_ENV_AT_BOOT === "production") {
  console.error(
    "[seed] Refusing to seed: NODE_ENV=production. Seeding resets data and " +
    "creates demo accounts with a known password."
  );
  process.exit(1);
}
if (SEED_DEMO_AT_BOOT !== "1") {
  console.error(
    "[seed] Refusing to seed: SEED_DEMO=1 not set.\n" +
    "  Seeding WIPES existing data and creates demo accounts with a " +
    "publicly-known password (see NEXT_PUBLIC_DEMO_ACCOUNTS / " +
    "NEXT_PUBLIC_DEMO_PASSWORD in .env).\n" +
    "  To run the seed explicitly: SEED_DEMO=1 bun run db:seed\n" +
    "  This guard closes L-P0-12 — see docs/CODE_REVIEW.md §9.4."
  );
  process.exit(1);
}

// Only now is it safe to load Prisma — it will source .env, but the guard
// above already snapshotted the real boot env so it can't be bypassed.
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const db = new PrismaClient();

const now = new Date();
const TODAY = new Date(now.getFullYear(), now.getMonth(), now.getDate());

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function addHours(date, n) {
  const d = new Date(date);
  d.setHours(d.getHours() + n);
  return d;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  // Secret hygiene: the demo password is NEVER a literal in this file. It
  // lives in .env (NEXT_PUBLIC_DEMO_PASSWORD) — the same value the login
  // screen and the e2e/scripts tooling read — so there is exactly one place
  // to change it and the repo stays greppable-clean. Checked BEFORE the
  // wipe below so a misconfigured environment can never destroy data and
  // then fail. (.env is on process.env now — Prisma loaded it above.)
  const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD;
  if (!DEMO_PASSWORD || DEMO_PASSWORD.length < 8) {
    console.error(
      "[seed] NEXT_PUBLIC_DEMO_PASSWORD is not set (or too short) in .env.\n" +
      "  The demo accounts need a password to hash. Set it in .env and retry:\n" +
      "  NEXT_PUBLIC_DEMO_PASSWORD=<choose-a-dev-only-password>"
    );
    process.exit(1);
  }

  console.log("🌱 Seeding Fernly database...");

  await db.notification.deleteMany();
  await db.timeEntry.deleteMany();
  await db.calendarEvent.deleteMany();
  await db.reminder.deleteMany();
  await db.task.deleteMany();
  await db.project.deleteMany();
  await db.teamMember.deleteMany();
  await db.user.deleteMany();
  await db.message.deleteMany();
  await db.auditLog.deleteMany();
  await db.rolePermission.deleteMany();
  await db.permission.deleteMany();
  await db.role.deleteMany();
  await db.taskStatusConfig.deleteMany();
  await db.projectStatusConfig.deleteMany();
  await db.eventTypeConfig.deleteMany();
  await db.taskTagConfig.deleteMany();
  await db.priorityConfig.deleteMany();
  await db.departmentConfig.deleteMany();
  await db.projectAssignment.deleteMany();
  await db.workspace.deleteMany();

  // -----------------------------------------------------------------
  // Workspace settings
  // -----------------------------------------------------------------
  await db.workspace.create({
    data: {
      id: "default",
      name: "Fernly Workspace",
      defaultTimezone: "Pacific/Auckland",
      defaultUserRole: "MEMBER",
      defaultDepartment: "ENGINEERING",
      defaultAvatarColor: "forest",
      defaultJobTitle: "Team Member",
      minPasswordLength: 8,
      workloadFullCapacity: 6,
      auditLogLimit: 300,
      entityHistoryLimit: 50,
      dashboardNotifLimit: 20,
    },
  });

  // -----------------------------------------------------------------
  // Task status config
  // -----------------------------------------------------------------
  const taskStatuses = [
    { key: "TODO", label: "To do", accentClass: "bg-zinc-400", sortOrder: 0, isTerminal: false, isVisible: true },
    { key: "IN_PROGRESS", label: "In progress", accentClass: "bg-blue-500", sortOrder: 1, isTerminal: false, isVisible: true },
    { key: "IN_REVIEW", label: "In review", accentClass: "bg-amber-500", sortOrder: 2, isTerminal: false, isVisible: true },
    { key: "DONE", label: "Done", accentClass: "bg-emerald-500", sortOrder: 3, isTerminal: true, isVisible: true },
  ];
  for (const s of taskStatuses) {
    await db.taskStatusConfig.create({ data: s });
  }

  // -----------------------------------------------------------------
  // Project status config
  // -----------------------------------------------------------------
  const projectStatuses = [
    { key: "RUNNING", label: "Running", badgeClass: "bg-primary/10 text-primary", dotClass: "bg-primary", sortOrder: 0, isVisible: true },
    { key: "PENDING", label: "Pending", badgeClass: "bg-warning/10 text-warning", dotClass: "bg-warning", sortOrder: 1, isVisible: true },
    { key: "PAUSED", label: "Paused", badgeClass: "bg-muted text-muted-foreground", dotClass: "bg-muted-foreground", sortOrder: 2, isVisible: true },
    { key: "ENDED", label: "Ended", badgeClass: "bg-success/10 text-success", dotClass: "bg-success", sortOrder: 3, isVisible: true },
  ];
  for (const s of projectStatuses) {
    await db.projectStatusConfig.create({ data: s });
  }

  // -----------------------------------------------------------------
  // Event type config
  // -----------------------------------------------------------------
  const eventTypes = [
    { key: "MEETING", label: "Meeting", dotClass: "bg-primary", bgClass: "bg-primary/10", sortOrder: 0, isVisible: true },
    { key: "DEADLINE", label: "Deadline", dotClass: "bg-destructive", bgClass: "bg-destructive/10", sortOrder: 1, isVisible: true },
    { key: "REVIEW", label: "Review", dotClass: "bg-amber-500", bgClass: "bg-amber-500/10", sortOrder: 2, isVisible: true },
    { key: "SOCIAL", label: "Social", dotClass: "bg-pink-500", bgClass: "bg-pink-500/10", sortOrder: 3, isVisible: true },
    { key: "FOCUS", label: "Focus", dotClass: "bg-emerald-500", bgClass: "bg-emerald-500/10", sortOrder: 4, isVisible: true },
  ];
  for (const e of eventTypes) {
    await db.eventTypeConfig.create({ data: e });
  }

  // -----------------------------------------------------------------
  // Task tag config
  // -----------------------------------------------------------------
  const taskTags = [
    { key: "FRONTEND", label: "Frontend", color: "oklch(0.65 0.15 250)", sortOrder: 0, isVisible: true },
    { key: "BACKEND", label: "Backend", color: "oklch(0.60 0.15 180)", sortOrder: 1, isVisible: true },
    { key: "DESIGN", label: "Design", color: "oklch(0.65 0.15 320)", sortOrder: 2, isVisible: true },
    { key: "QA", label: "QA", color: "oklch(0.65 0.15 60)", sortOrder: 3, isVisible: true },
    { key: "MARKETING", label: "Marketing", color: "oklch(0.65 0.15 10)", sortOrder: 4, isVisible: true },
  ];
  for (const t of taskTags) {
    await db.taskTagConfig.create({ data: t });
  }

  // -----------------------------------------------------------------
  // Priority config
  // -----------------------------------------------------------------
  const priorityConfigs = [
    { key: "HIGH", label: "High", color: "oklch(0.58 0.18 25)", sortOrder: 0, isVisible: true },
    { key: "MEDIUM", label: "Medium", color: "oklch(0.6 0.1 80)", sortOrder: 1, isVisible: true },
    { key: "LOW", label: "Low", color: "oklch(0.6 0.05 250)", sortOrder: 2, isVisible: true },
  ];
  for (const p of priorityConfigs) {
    await db.priorityConfig.create({ data: p });
  }

  // -----------------------------------------------------------------
  // Department config
  // -----------------------------------------------------------------
  const departments = [
    { key: "ENGINEERING", label: "Engineering", sortOrder: 0, isVisible: true },
    { key: "DESIGN", label: "Design", sortOrder: 1, isVisible: true },
    { key: "MARKETING", label: "Marketing", sortOrder: 2, isVisible: true },
    { key: "MANAGEMENT", label: "Management", sortOrder: 3, isVisible: true },
  ];
  for (const d of departments) {
    await db.departmentConfig.create({ data: d });
  }

  // -----------------------------------------------------------------
  // Permissions
  // -----------------------------------------------------------------
  const permissionDefs = [
    { key: "task:create", label: "Create tasks", description: "Add new tasks to the Kanban board", group: "Tasks", sortOrder: 0 },
    { key: "task:edit:own", label: "Edit own tasks", description: "Modify tasks assigned to you", group: "Tasks", sortOrder: 1 },
    { key: "task:edit:any", label: "Edit any task", description: "Modify tasks assigned to anyone", group: "Tasks", sortOrder: 2 },
    { key: "task:delete", label: "Delete tasks", description: "Remove tasks from the board", group: "Tasks", sortOrder: 3 },
    { key: "project:create", label: "Create projects", description: "Add new projects to the workspace", group: "Projects", sortOrder: 4 },
    { key: "project:edit", label: "Edit projects", description: "Modify project details and status", group: "Projects", sortOrder: 5 },
    { key: "project:delete", label: "Delete projects", description: "Remove projects permanently", group: "Projects", sortOrder: 6 },
    { key: "member:invite", label: "Invite members", description: "Add new team members", group: "Team", sortOrder: 7 },
    { key: "member:edit", label: "Edit members", description: "Modify team member details", group: "Team", sortOrder: 8 },
    { key: "member:delete", label: "Remove members", description: "Remove team members", group: "Team", sortOrder: 9 },
    { key: "message:send", label: "Send messages", description: "Send messages to team members", group: "Communication", sortOrder: 10 },
    { key: "event:create", label: "Create events", description: "Add events to the calendar", group: "Calendar", sortOrder: 11 },
    { key: "event:delete", label: "Delete events", description: "Remove calendar events", group: "Calendar", sortOrder: 12 },
    { key: "settings:edit", label: "Edit settings", description: "Modify own profile and preferences", group: "General", sortOrder: 13 },
    { key: "role:manage", label: "Manage roles", description: "Change other users' roles and manage workspace config", group: "General", sortOrder: 14 },
    { key: "analytics:view", label: "View analytics", description: "Access the analytics dashboard", group: "General", sortOrder: 15 },
    { key: "team:view", label: "View team", description: "See the team member directory", group: "Team", sortOrder: 16 },
    { key: "audit:view", label: "View audit log", description: "See the full history of who changed what", group: "General", sortOrder: 17 },
  ];
  const permissionMap = {};
  for (const p of permissionDefs) {
    permissionMap[p.key] = await db.permission.create({ data: p });
  }

  // -----------------------------------------------------------------
  // Roles + RolePermission matrix
  // -----------------------------------------------------------------
  const roleDefs = [
    {
      key: "ADMIN", label: "Admin", description: "Full access — can delete anything, manage roles, and configure the workspace",
      iconName: "ShieldAlert", badgeClass: "bg-destructive/10 text-destructive", isSystem: true, sortOrder: 0,
      permissions: Object.keys(permissionMap), // all permissions
    },
    {
      key: "MANAGER", label: "Manager", description: "Can create projects, invite members, and edit tasks. Cannot delete or manage roles.",
      iconName: "ShieldCheck", badgeClass: "bg-primary/10 text-primary", isSystem: true, sortOrder: 1,
      permissions: ["task:create", "task:edit:any", "task:edit:own", "project:create", "project:edit", "member:invite", "message:send", "event:create", "event:delete", "settings:edit", "analytics:view", "team:view", "audit:view"],
    },
    {
      key: "MEMBER", label: "Member", description: "Can create/edit own tasks, send messages, and view analytics. Cannot create projects or invite members.",
      iconName: "Shield", badgeClass: "bg-muted text-muted-foreground", isSystem: true, sortOrder: 2,
      permissions: ["task:create", "task:edit:own", "message:send", "settings:edit", "analytics:view", "team:view"],
    },
  ];
  for (const r of roleDefs) {
    const role = await db.role.create({
      data: {
        key: r.key,
        label: r.label,
        description: r.description,
        iconName: r.iconName,
        badgeClass: r.badgeClass,
        isSystem: r.isSystem,
        sortOrder: r.sortOrder,
      },
    });
    for (const permKey of r.permissions) {
      await db.rolePermission.create({
        data: {
          roleId: role.id,
          permissionId: permissionMap[permKey].id,
        },
      });
    }
  }

  // -----------------------------------------------------------------
  // Users — multiple roles for RBAC testing + realistic team
  // -----------------------------------------------------------------
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const demoUser = await db.user.create({
    data: {
      email: "demo@fernly.app",
      name: "Mira Hale",
      passwordHash,
      role: "ADMIN",
      timezone: "Pacific/Auckland",
      bio: "Workspace admin at Halcyon Labs. Coffee enthusiast, trail runner, occasional watercolorist.",
      avatarColor: "forest",
    },
  });
  const managerUser = await db.user.create({
    data: {
      email: "manager@fernly.app",
      name: "Ingrid Solberg",
      passwordHash,
      role: "MANAGER",
      timezone: "Europe/Oslo",
      bio: "Engineering Manager. Keeps the trains running on time.",
      avatarColor: "ocean",
    },
  });
  const memberUser = await db.user.create({
    data: {
      email: "member@fernly.app",
      name: "Theo Vance",
      passwordHash,
      role: "MEMBER",
      timezone: "Pacific/Auckland",
      bio: "Senior Frontend Engineer. Loves clean code and good coffee.",
      avatarColor: "plum",
    },
  });
  // Additional users for a more realistic team
  const extraUsers = [
    { email: "lena@fernly.app", name: "Lena Okafor", role: "MEMBER", timezone: "Europe/London", bio: "Backend Engineer. API design enthusiast.", avatarColor: "ember" },
    { email: "rafael@fernly.app", name: "Rafael Costa", role: "MEMBER", timezone: "America/Sao_Paulo", bio: "DevOps Engineer. Kubernetes whisperer.", avatarColor: "ocean" },
    { email: "yuki@fernly.app", name: "Yuki Tanaka", role: "MEMBER", timezone: "Asia/Tokyo", bio: "Product Designer. Pixel perfectionist.", avatarColor: "plum" },
    { email: "amara@fernly.app", name: "Amara Diallo", role: "MEMBER", timezone: "Africa/Dakar", bio: "UX Researcher. Champion of the user.", avatarColor: "forest" },
    { email: "soren@fernly.app", name: "Soren Lindqvist", role: "MEMBER", timezone: "Europe/Stockholm", bio: "QA Engineer. Finds bugs you didn't know existed.", avatarColor: "ember" },
    { email: "priya@fernly.app", name: "Priya Nair", role: "MANAGER", timezone: "Asia/Kolkata", bio: "Marketing Lead. Storyteller and brand strategist.", avatarColor: "ocean" },
    { email: "marcus@fernly.app", name: "Marcus Bell", role: "MEMBER", timezone: "America/New_York", bio: "Content Strategist. Words that work.", avatarColor: "plum" },
    { email: "hana@fernly.app", name: "Hana Park", role: "MEMBER", timezone: "Asia/Seoul", bio: "Senior Designer. Design system architect.", avatarColor: "forest" },
    { email: "diego@fernly.app", name: "Diego Morales", role: "MEMBER", timezone: "America/Mexico_City", bio: "Full-stack Engineer. Ships fast.", avatarColor: "ember" },
  ];
  for (const u of extraUsers) {
    await db.user.create({ data: { ...u, passwordHash } });
  }
  console.log(`  ✓ ${3 + extraUsers.length} users (ADMIN, MANAGER, MEMBER) — all password: $NEXT_PUBLIC_DEMO_PASSWORD (from .env)`);
  console.log(`  ✓ User: ${demoUser.email}`);

  // Name → user map for the stable-identity links below. Seed names are
  // unique, so a name map is deterministic here.
  const allUsers = await db.user.findMany({ select: { id: true, name: true } });
  const userByName = new Map(allUsers.map((u) => [u.name, u.id]));

  // -----------------------------------------------------------------
  // Reporting hierarchy (org chart) — 3-level tree rooted at the ADMIN.
  //   Mira (ADMIN, root)
  //     ├── Ingrid (MANAGER)        ← Engineering Manager
  //     │     ├── Lena              ← Backend Eng
  //     │     ├── Rafael            ← DevOps
  //     │     └── Soren             ← QA
  //     ├── Priya (MANAGER)         ← Marketing Lead
  //     │     ├── Marcus            ← Content
  //     │     └── Hana              ← Design
  //     ├── Theo                    ← Frontend (reports to admin directly)
  //     ├── Yuki                    ← Product Designer
  //     ├── Amara                   ← UX Researcher
  //     └── Diego                   ← Full-stack
  // -----------------------------------------------------------------
  const mgrIngrid = userByName.get("Ingrid Solberg");
  const mgrPriya = userByName.get("Priya Nair");
  const treeAssignments = [
    ["Ingrid Solberg", demoUser.id],          // Ingrid → Mira
    ["Priya Nair", demoUser.id],              // Priya → Mira
    ["Theo Vance", demoUser.id],              // Theo → Mira
    ["Yuki Tanaka", demoUser.id],
    ["Amara Diallo", demoUser.id],
    ["Diego Morales", demoUser.id],
    ["Lena Okafor", mgrIngrid],               // Lena → Ingrid
    ["Rafael Costa", mgrIngrid],
    ["Soren Lindqvist", mgrIngrid],
    ["Marcus Bell", mgrPriya],                // Marcus → Priya
    ["Hana Park", mgrPriya],
  ];
  for (const [name, mgrId] of treeAssignments) {
    const uid = userByName.get(name);
    if (uid && mgrId) {
      await db.user.update({ where: { id: uid }, data: { managerId: mgrId } });
    }
  }
  console.log(`  ✓ Reporting hierarchy: ${treeAssignments.length} manager edges set`);

  // -----------------------------------------------------------------
  // Team Members (12)
  // -----------------------------------------------------------------
  const memberSeed = [
    { name: "Mira Hale", role: "Project Lead", department: "MANAGEMENT", email: "mira@fernly.app", avatarColor: "forest", online: true },
    { name: "Theo Vance", role: "Senior Frontend Engineer", department: "ENGINEERING", email: "theo@fernly.app", avatarColor: "ocean", online: true },
    { name: "Lena Okafor", role: "Backend Engineer", department: "ENGINEERING", email: "lena@fernly.app", avatarColor: "plum", online: true },
    { name: "Rafael Costa", role: "DevOps Engineer", department: "ENGINEERING", email: "rafael@fernly.app", avatarColor: "ember", online: false },
    { name: "Yuki Tanaka", role: "Product Designer", department: "DESIGN", email: "yuki@fernly.app", avatarColor: "plum", online: true },
    { name: "Amara Diallo", role: "UX Researcher", department: "DESIGN", email: "amara@fernly.app", avatarColor: "forest", online: false },
    { name: "Soren Lindqvist", role: "QA Engineer", department: "ENGINEERING", email: "soren@fernly.app", avatarColor: "ocean", online: true },
    { name: "Priya Nair", role: "Marketing Lead", department: "MARKETING", email: "priya@fernly.app", avatarColor: "ember", online: true },
    { name: "Marcus Bell", role: "Content Strategist", department: "MARKETING", email: "marcus@fernly.app", avatarColor: "forest", online: false },
    { name: "Ingrid Solberg", role: "Engineering Manager", department: "MANAGEMENT", email: "ingrid@fernly.app", avatarColor: "slate", online: true },
    { name: "Diego Morales", role: "Mobile Engineer", department: "ENGINEERING", email: "diego@fernly.app", avatarColor: "ocean", online: false },
    { name: "Hana Park", role: "Visual Designer", department: "DESIGN", email: "hana@fernly.app", avatarColor: "plum", online: false },
  ];

  const members = [];
  for (const m of memberSeed) {
    const member = await db.teamMember.create({
      data: {
        ...m,
        // Stable identity: link the roster entry to the user account.
        userId: userByName.get(m.name) ?? null,
        openTasks: 0,
        completedTasks: 0,
        workload: 0,
      },
    });
    members.push(member);
  }
  console.log(`  ✓ ${members.length} team members`);

  // -----------------------------------------------------------------
  // Projects (24)
  // -----------------------------------------------------------------
  const projectTemplates = [
    "Halcyon Labs Website", "Fernly Mobile App", "Atlas Analytics Platform",
    "Orion Design System", "Cobalt CRM Migration", "Sage Payments API",
    "Lumen Email Campaign", "Pulse Customer Portal", "Verdant Sustainability Report",
    "Nimbus Cloud Migration", "Tidepool Data Lake", "Ember Marketing Site",
    "Quill Documentation Hub", "Beacon Onboarding Flow", "Driftwood Mobile SDK",
    "Sundial Calendar Sync", "Cinder Security Audit", "Marigold Brand Refresh",
    "Halcyon iOS Release", "Fernly v2.0 Launch", "Atlas Reports Module",
    "Orion Icon Library", "Cobalt Mobile Sync", "Sage Webhooks v3",
  ];
  const statuses = ["RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","RUNNING","ENDED","ENDED","ENDED","ENDED","ENDED","ENDED","ENDED","ENDED","ENDED","ENDED","PENDING","PAUSED"];
  const priorities = ["HIGH", "MEDIUM", "LOW"];
  const colors = ["forest", "ocean", "plum", "ember", "slate"];

  const projects = [];
  // Deterministic ownership so each demo user is associated with real projects
  // (index → owner name). Others stay random.
  const explicitOwners = {
    0: "Mira Hale",        // Halcyon Labs Website
    1: "Mira Hale",        // Fernly Mobile App
    4: "Mira Hale",        // Lumen Email Campaign
    2: "Theo Vance",       // Atlas Analytics Platform
    14: "Theo Vance",      // Driftwood Mobile SDK
    18: "Ingrid Solberg",  // Halcyon iOS Release
    19: "Ingrid Solberg",  // Fernly v2.0 Launch
    7: "Ingrid Solberg",   // Pulse Customer Portal
  };
  for (let i = 0; i < 24; i++) {
    const status = statuses[i];
    const owner = explicitOwners[i] ?? pick(members).name;
    const ownerMember = members.find((m) => m.name === owner) ?? null;
    const progress = status === "ENDED" ? 100 : status === "PENDING" ? 0 : Math.floor(15 + Math.random() * 75);
    const dueDate = status === "ENDED"
      ? addDays(TODAY, -(Math.floor(Math.random() * 60) + 5))
      : addDays(TODAY, Math.floor(Math.random() * 90) + 3);
    const p = await db.project.create({
      data: {
        name: projectTemplates[i],
        description: `${projectTemplates[i]} — internal initiative led by ${owner}.`,
        status,
        priority: pick(priorities),
        dueDate,
        progress,
        color: pick(colors),
        ownerName: owner,
        // Stable identity: the authoritative owner link (ownerName above is
        // only the display copy).
        ownerUserId: ownerMember?.userId ?? userByName.get(owner) ?? null,
      },
    });
    projects.push(p);
  }
  console.log(`  ✓ ${projects.length} projects`);

  // -----------------------------------------------------------------
  // Tasks (40 across all 4 columns)
  // -----------------------------------------------------------------
  const taskTitles = [
    "Implement auth flow with NextAuth", "Build Kanban drag-drop with dnd-kit",
    "Design dashboard KPI cards", "Write E2E tests for login",
    "Migrate legacy API to tRPC", "Optimize bundle size",
    "Add dark mode toggle", "Create calendar event modal",
    "Set up Prisma schema", "Refactor analytics service",
    "Build team member cards", "Add command palette",
    "Design empty states", "Write API integration tests",
    "Implement notifications drawer", "Create settings forms",
    "Add responsive breakpoints", "Build analytics charts",
    "Set up CI/CD pipeline", "Optimize database queries",
    "Design onboarding flow", "Add keyboard shortcuts",
    "Build help center search", "Create project color picker",
    "Implement CSV export", "Add workload indicators",
    "Build time tracker widget", "Design priority badges",
    "Create reminder cards", "Add member filter chips",
    "Implement activity graph", "Build top contributors list",
    "Add tag system to tasks", "Create due-date picker",
    "Build mobile sidebar", "Add toast notifications",
    "Implement task reordering", "Create dashboard widgets",
    "Add member profile drawer", "Build event type colors",
  ];
  const tags = ["FRONTEND", "BACKEND", "DESIGN", "QA", "MARKETING"];
  const statusDistribution = [
    ...Array(11).fill("TODO"),
    ...Array(9).fill("IN_PROGRESS"),
    ...Array(7).fill("IN_REVIEW"),
    ...Array(13).fill("DONE"),
  ];

  let order = 0;
  const tasks = [];
  // Guarantee each demo user (Mira=0, Theo=1, Ingrid=9) is assigned tasks in
  // several projects so their task modal shows associated projects.
  const explicitAssignments = [
    { memberIdx: 0, projectIdx: 0 },   // Mira — Halcyon Labs Website
    { memberIdx: 1, projectIdx: 1 },   // Theo — Fernly Mobile App
    { memberIdx: 0, projectIdx: 4 },   // Mira — Lumen Email Campaign
    { memberIdx: 9, projectIdx: 18 },  // Ingrid — Halcyon iOS Release
    { memberIdx: 1, projectIdx: 2 },   // Theo — Atlas Analytics Platform
    { memberIdx: 9, projectIdx: 19 },  // Ingrid — Fernly v2.0 Launch
    { memberIdx: 0, projectIdx: 2 },   // Mira — Atlas Analytics Platform
    { memberIdx: 1, projectIdx: 14 },  // Theo — Driftwood Mobile SDK
    { memberIdx: 9, projectIdx: 1 },   // Ingrid — Fernly Mobile App
    { memberIdx: 0, projectIdx: 1 },   // Mira — Fernly Mobile App
  ];
  for (let i = 0; i < taskTitles.length; i++) {
    const status = statusDistribution[i] || "TODO";
    const project = i < explicitAssignments.length
      ? projects[explicitAssignments[i].projectIdx]
      : pick(projects);
    const assignee = i < explicitAssignments.length
      ? members[explicitAssignments[i].memberIdx]
      : pick(members);
    const dueDate = Math.random() > 0.2 ? addDays(TODAY, Math.floor(Math.random() * 30) - 5) : null;
    const task = await db.task.create({
      data: {
        title: taskTitles[i],
        description: `${taskTitles[i]}. Scope and acceptance criteria defined in the project brief.`,
        status,
        priority: pick(priorities),
        tag: pick(tags),
        dueDate,
        order: order++,
        projectId: project.id,
        assigneeId: assignee.id,
      },
    });
    tasks.push(task);
  }
  console.log(`  ✓ ${tasks.length} tasks`);

  // Recompute member stats
  for (const m of members) {
    const open = tasks.filter((t) => t.assigneeId === m.id && t.status !== "DONE").length;
    const completed = tasks.filter((t) => t.assigneeId === m.id && t.status === "DONE").length;
    const workload = Math.min(100, Math.round((open / 6) * 100));
    await db.teamMember.update({ where: { id: m.id }, data: { openTasks: open, completedTasks: completed, workload } });
  }

  // -----------------------------------------------------------------
  // Project Assignments — assign users to projects so counts are non-zero
  // -----------------------------------------------------------------
  const usersForAssignments = await db.user.findMany();
  for (const u of usersForAssignments) {
    // Assign each user to 2-5 random projects
    const numAssignments = Math.floor(Math.random() * 4) + 2;
    const shuffled = [...projects].sort(() => Math.random() - 0.5);
    for (let i = 0; i < numAssignments && i < shuffled.length; i++) {
      await db.projectAssignment.upsert({
        where: { projectId_userId: { projectId: shuffled[i].id, userId: u.id } },
        create: {
          projectId: shuffled[i].id,
          userId: u.id,
          role: shuffled[i].ownerName === u.name ? "OWNER" : "MEMBER",
        },
        update: {},
      });
    }
  }
  console.log(`  ✓ Project assignments for ${allUsers.length} users`);

  // -----------------------------------------------------------------
  // Calendar Events (18)
  // -----------------------------------------------------------------
  const eventTitles = [
    { title: "Sprint Planning", type: "MEETING" },
    { title: "Design Review — Orion", type: "REVIEW" },
    { title: "Halcyon Labs Check-in", type: "MEETING" },
    { title: "Fernly v2.0 Launch", type: "DEADLINE" },
    { title: "1:1 with Ingrid", type: "MEETING" },
    { title: "QA Sync", type: "REVIEW" },
    { title: "Marketing Standup", type: "MEETING" },
    { title: "Deep Work — Atlas", type: "FOCUS" },
    { title: "Team Lunch", type: "SOCIAL" },
    { title: "Demo Day", type: "MEETING" },
    { title: "Cobalt Migration Cutoff", type: "DEADLINE" },
    { title: "User Research Debrief", type: "REVIEW" },
    { title: "Engineering All-Hands", type: "MEETING" },
    { title: "Brand Refresh Review", type: "REVIEW" },
    { title: "Onboarding Workshop", type: "MEETING" },
    { title: "Focus: API Refactor", type: "FOCUS" },
    { title: "Sprint Retro", type: "REVIEW" },
    { title: "Fernly Birthday", type: "SOCIAL" },
  ];
  const times = ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
  const locations = ["Google Meet", "Room A — Kauri", "Room B — Rimu", "Zoom", "Slack Huddle", "Office Kitchen"];

  for (let i = 0; i < eventTitles.length; i++) {
    const e = eventTitles[i];
    const offset = Math.floor(Math.random() * 50) - 10;
    await db.calendarEvent.create({
      data: {
        title: e.title,
        description: `${e.title}. ${e.type === "DEADLINE" ? "Hard deadline — please plan accordingly." : "Open to all relevant contributors."}`,
        date: addDays(TODAY, offset),
        time: pick(times),
        durationMin: pick([30, 45, 60, 90]),
        type: e.type,
        location: pick(locations),
      },
    });
  }
  console.log(`  ✓ ${eventTitles.length} calendar events`);

  // -----------------------------------------------------------------
  // Notifications (10) — routed per-user since the §6.2 hardening:
  //   • rows with `recipientUserId` are private to that user
  //   • rows with null recipient are workspace-wide broadcasts
  // -----------------------------------------------------------------
  const demoUserId = demoUser.id;
  // managerUser / memberUser are created earlier in the seed — reuse them.
  const notifs = [
    { title: "Task assigned", message: "Theo Vance assigned you “Implement auth flow with NextAuth”", type: "TASK", recipientUserId: demoUserId },
    { title: "Reminder: Halcyon check-in", message: "Check-in with Halcyon Labs is due in 2 hours.", type: "WARNING", recipientUserId: demoUserId },
    { title: "Project ended", message: "Halcyon Labs Website marked as ended. Archived to Reports.", type: "INFO", recipientUserId: null },
    { title: "Mention", message: "Yuki Tanaka mentioned you in “Design Review — Orion”.", type: "MENTION", recipientUserId: demoUserId },
    { title: "Sprint complete", message: "Sprint 14 wrapped up — 18 of 22 tasks completed.", type: "SUCCESS", recipientUserId: managerUser?.id ?? null },
    { title: "Due soon", message: "“Fernly v2.0 Launch” is due in 3 days.", type: "WARNING", recipientUserId: demoUserId },
    { title: "New member", message: "Hana Park joined the Design team. Say hi!", type: "INFO", recipientUserId: null },
    { title: "Time to log", message: "You have 4.5h unlogged time this week.", type: "INFO", recipientUserId: memberUser?.id ?? null },
    { title: "Quarterly report ready", message: "The Q3 workspace report is available in Reports.", type: "INFO", recipientUserId: managerUser?.id ?? null },
    { title: "Welcome to Fernly", message: "Explore the dashboard and set up your profile.", type: "SUCCESS", recipientUserId: null },
  ];
  for (let i = 0; i < notifs.length; i++) {
    await db.notification.create({
      data: {
        ...notifs[i],
        read: i > 4,
        createdAt: addHours(now, -i * 3 - 1),
      },
    });
  }
  console.log(`  ✓ ${notifs.length} notifications`);

  // -----------------------------------------------------------------
  // Time entries (~180 across 90 days)
  // -----------------------------------------------------------------
  let teCount = 0;
  for (let d = 89; d >= 0; d--) {
    const date = addDays(TODAY, -d);
    const day = date.getDay();
    if (day === 0 || day === 6) continue;
    const entriesToday = Math.floor(Math.random() * 4) + 1;
    for (let j = 0; j < entriesToday; j++) {
      await db.timeEntry.create({
        data: {
          projectId: pick(projects).id,
          memberId: pick(members).id,
          date,
          hours: Math.round((Math.random() * 4 + 1) * 10) / 10,
          description: pick(["Code review", "Feature work", "Planning", "Bug fix", "Design sync", "Testing", "Documentation"]),
        },
      });
      teCount++;
    }
  }
  console.log(`  ✓ ${teCount} time entries across 90 days`);

  // -----------------------------------------------------------------
  // Reminders (5)
  // -----------------------------------------------------------------
  const reminders = [
    { title: "Check-in with Halcyon Labs", dueDate: addDays(TODAY, 0) },
    { title: "Review PRs from Theo", dueDate: addDays(TODAY, 1) },
    { title: "Send Fernly v2.0 announcement", dueDate: addDays(TODAY, 2) },
    { title: "Approve Q3 marketing budget", dueDate: addDays(TODAY, 4) },
    { title: "1:1 prep with Ingrid", dueDate: addDays(TODAY, -1) },
  ];
  for (const r of reminders) {
    await db.reminder.create({
      data: { title: r.title, dueDate: r.dueDate, completed: r.dueDate < TODAY },
    });
  }
  console.log(`  ✓ ${reminders.length} reminders`);

  // -----------------------------------------------------------------
  // Messages (incoming from team members + one sent)
  // -----------------------------------------------------------------
  await db.message.deleteMany();

  const seedMessages = [
    {
      from: members[1], // Theo Vance
      subject: "Auth flow PR ready for review",
      body: "Hey Mira,\n\nI just pushed the NextAuth implementation to the `feature/auth-flow` branch. It's ready for your review whenever you have a moment.\n\nKey points:\n- Credentials provider with bcrypt hashing\n- JWT session strategy\n- Cookie config for reverse-proxy environments\n\nCould you take a look before EOD? I'd like to merge before the sprint ends.\n\nThanks!\nTheo",
      daysAgo: 0,
      read: false,
    },
    {
      from: members[4], // Yuki Tanaka
      subject: "Orion design review — feedback needed",
      body: "Hi Mira,\n\nI've attached the latest Orion design system mockups. The main changes are:\n\n1. Updated color tokens for accessibility (WCAG AA)\n2. New iconography set (48 icons)\n3. Component spacing refinements\n\nCan we schedule a 30-min review this week? I'd love your input on the color palette before we finalize.\n\nBest,\nYuki",
      daysAgo: 1,
      read: false,
    },
    {
      from: members[9], // Ingrid Solberg
      subject: "Sprint retro notes + action items",
      body: "Mira,\n\nGreat sprint everyone! Here are the retro notes:\n\n**What went well:**\n- Fernly v2.0 on track for launch\n- Cross-team collaboration improved\n- Bug turnaround time down 23%\n\n**Action items:**\n1. Review QA process (Soren leading)\n2. Update documentation hub (Marcus)\n3. Plan v2.1 roadmap (you + me next week)\n\nLet's chat Thursday about the roadmap.\n\nIngrid",
      daysAgo: 2,
      read: true,
    },
    {
      from: members[7], // Priya Nair
      subject: "Fernly v2.0 launch — marketing plan",
      body: "Hi Mira,\n\nThe marketing plan for the v2.0 launch is ready. We're targeting a 3-week campaign:\n\n- Week 1: Teaser social posts + email to waitlist\n- Week 2: Product hunt launch + blog post\n- Week 3: Customer spotlight + webinar\n\nBudget: $4.2k (within Q4 allocation). Can you approve by Friday so we can start scheduling?\n\nPriya",
      daysAgo: 3,
      read: false,
    },
    {
      from: members[6], // Soren Lindqvist
      subject: "QA: Found 3 blockers in staging",
      body: "Mira,\n\nI found 3 blocker-level bugs in staging during regression testing:\n\n1. **Kanban drag-drop breaks on mobile** — cards become unresponsive after first drag\n2. **Calendar events don't persist** — POST returns 200 but event doesn't appear\n3. **Analytics CSV export** — filename has undefined when period is 7D\n\nI've logged all three in the tracker. Theo and Lena are aware. We should fix before launch.\n\nSoren",
      daysAgo: 4,
      read: true,
    },
    {
      from: members[2], // Lena Okafor
      subject: "Atlas API — need your input on schema",
      body: "Hey,\n\nI'm working on the Atlas analytics API and I'm stuck on the schema design for the time-series tables. Two options:\n\n**Option A:** Wide table (one row per day, columns per metric)\n**Option B:** Narrow/EAV (one row per metric per day)\n\nOption A is faster to query but harder to extend. Option B is flexible but needs more joins.\n\nCan we sync for 15 min tomorrow? I'd value your perspective.\n\nLena",
      daysAgo: 5,
      read: true,
    },
  ];

  // For each seed message, look up the sender's User account (by email) to set senderUserId
  for (const msg of seedMessages) {
    const threadId = `seed-${msg.from.id}-${msg.daysAgo}`;
    const senderUser = await db.user.findUnique({ where: { email: msg.from.email.toLowerCase() }, select: { id: true } });
    await db.message.create({
      data: {
        direction: "IN",
        threadId,
        memberId: msg.from.id,
        senderUserId: senderUser?.id || "",
        recipientUserId: demoUser.id,
        senderName: msg.from.name,
        senderAvatarColor: msg.from.avatarColor,
        senderRole: msg.from.role,
        recipientName: demoUser.name,
        subject: msg.subject,
        body: msg.body,
        read: msg.read,
        createdAt: addDays(now, -msg.daysAgo),
      },
    });
  }

  // One sent message (reply to Theo)
  const theoUser = await db.user.findUnique({ where: { email: "member@fernly.app" }, select: { id: true } });
  await db.message.create({
    data: {
      direction: "OUT",
      threadId: `seed-${members[1].id}-0`,
      memberId: members[1].id,
      senderUserId: demoUser.id,
      recipientUserId: theoUser?.id || "",
      senderName: demoUser.name,
      senderAvatarColor: "forest",
      senderRole: demoUser.role,
      recipientName: members[1].name,
      subject: "Re: Auth flow PR ready for review",
      body: "Thanks Theo!\n\nI'll review it this afternoon. The proxy cookie config looks solid — that was the tricky part.\n\nI'll leave comments in the PR if I spot anything. Plan to merge by 5pm.\n\nMira",
      read: true,
      createdAt: addDays(now, 0),
    },
  });

  console.log(`  ✓ ${seedMessages.length + 1} messages (6 incoming, 1 sent)`);

  // -----------------------------------------------------------------
  // Audit Log — realistic trail of the last ~10 days
  // -----------------------------------------------------------------
  async function audit(actor, actorRole, action, entityType, entityLabel, detail, daysAgo, hoursAgo) {
    const createdAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000 - hoursAgo * 60 * 60 * 1000);
    await db.auditLog.create({
      data: {
        actorId: actor.id,
        actorName: actor.name,
        actorRole,
        action,
        entityType,
        entityId: "",
        entityLabel,
        detail,
        createdAt,
      },
    });
  }

  const ADMIN = "ADMIN", MANAGER = "MANAGER", MEMBER = "MEMBER";
  const mira = demoUser, ingrid = managerUser, theo = memberUser;

  const auditEntries = [
    // Today
    [mira, ADMIN, "auth.signed_in", "AUTH", "demo@fernly.app", "Mira Hale signed in to the workspace", 0, 2],
    [theo, MEMBER, "task.moved", "TASK", "Build Kanban drag-drop with dnd-kit", "Moved “Build Kanban drag-drop with dnd-kit” to In review", 0, 3],
    [ingrid, MANAGER, "event.created", "EVENT", "Sprint Retro", "Scheduled “Sprint Retro” on " + fmt(new Date(now.getTime() + 2 * 864e5)) + " at 15:00", 0, 5],
    [mira, ADMIN, "time.logged", "TIME", "Fernly Mobile App", "Logged 3.5h on “Fernly Mobile App”", 0, 6],
    [theo, MEMBER, "task.created", "TASK", "Add biometric unlock to mobile app", "Created task “Add biometric unlock to mobile app” in Fernly Mobile App", 0, 7],
    // Yesterday
    [theo, MEMBER, "auth.signed_in", "AUTH", "member@fernly.app", "Theo Vance signed in to the workspace", 1, 8],
    [mira, ADMIN, "project.created", "PROJECT", "Quill Documentation Hub", "Created project “Quill Documentation Hub”", 1, 6],
    [ingrid, MANAGER, "task.updated", "TASK", "Optimize database queries", "Updated priority, assignee on “Optimize database queries”", 1, 4],
    [theo, MEMBER, "reminder.completed", "REMINDER", "Review PRs from Theo", "Completed reminder “Review PRs from Theo”", 1, 2],
    [mira, ADMIN, "message.sent", "MESSAGE", "Re: Auth flow PR ready for review", "Sent “Re: Auth flow PR ready for review” to Theo Vance", 1, 1],
    // 2 days ago
    [ingrid, MANAGER, "auth.signed_in", "AUTH", "manager@fernly.app", "Ingrid Solberg signed in to the workspace", 2, 7],
    [ingrid, MANAGER, "project.updated", "PROJECT", "Fernly v2.0 Launch", "Updated progress on project “Fernly v2.0 Launch”", 2, 5],
    [mira, ADMIN, "role.changed", "ROLE", "Lena Okafor", "Changed role of Lena Okafor from Member to Manager", 2, 4],
    [theo, MEMBER, "task.moved", "TASK", "Implement auth flow with NextAuth", "Moved “Implement auth flow with NextAuth” to Done", 2, 2],
    // 3 days ago
    [theo, MEMBER, "message.sent", "MESSAGE", "QA: Found 3 blockers in staging", "Sent “QA: Found 3 blockers in staging” to Mira Hale", 3, 6],
    [mira, ADMIN, "member.invited", "MEMBER", "Hana Park", "Invited Hana Park (Visual Designer) to the team", 3, 4],
    [mira, ADMIN, "auth.signed_in", "AUTH", "demo@fernly.app", "Mira Hale signed in to the workspace", 3, 7],
    [ingrid, MANAGER, "event.deleted", "EVENT", "Marketing Standup (moved)", "Deleted event “Marketing Standup (moved)”", 3, 1],
    // 4 days ago
    [mira, ADMIN, "project.updated", "PROJECT", "Orion Design System", "Updated status, due date on project “Orion Design System”", 4, 6],
    [ingrid, MANAGER, "member.updated", "MEMBER", "Diego Morales", "Updated job title for Diego Morales", 4, 3],
    [theo, MEMBER, "task.created", "TASK", "Write E2E tests for login", "Created task “Write E2E tests for login” in Fernly Mobile App", 4, 1],
    // 5 days ago
    [ingrid, MANAGER, "project.created", "PROJECT", "Sundial Calendar Sync", "Created project “Sundial Calendar Sync”", 5, 6],
    [mira, ADMIN, "event.created", "EVENT", "Demo Day", "Scheduled “Demo Day” on " + fmt(new Date(now.getTime() + 5 * 864e5)) + " at 14:00", 5, 3],
    [theo, MEMBER, "task.moved", "TASK", "Build team member cards", "Moved “Build team member cards” to In progress", 5, 1],
    // 6 days ago
    [mira, ADMIN, "time.logged", "TIME", "Halcyon Labs Website", "Logged 6.5h on “Halcyon Labs Website”", 6, 5],
    [ingrid, MANAGER, "auth.signed_in", "AUTH", "manager@fernly.app", "Ingrid Solberg signed in to the workspace", 6, 8],
    [mira, ADMIN, "reminder.created", "REMINDER", "Approve Q3 marketing budget", "Added reminder “Approve Q3 marketing budget”", 6, 2],
    // 7 days ago
    [mira, ADMIN, "user.account_created", "USER", "Priya Nair", "Created a login account for Priya Nair (priya@fernly.app)", 7, 5],
    [ingrid, MANAGER, "task.updated", "TASK", "Set up CI/CD pipeline", "Updated description on “Set up CI/CD pipeline”", 7, 3],
    [theo, MEMBER, "message.sent", "MESSAGE", "Atlas API — need your input on schema", "Sent “Atlas API — need your input on schema” to Mira Hale", 7, 1],
    // 8 days ago
    [mira, ADMIN, "project.deleted", "PROJECT", "Slate Legacy Cleanup", "Deleted project “Slate Legacy Cleanup”", 8, 6],
    [mira, ADMIN, "auth.signed_in", "AUTH", "demo@fernly.app", "Mira Hale signed in to the workspace", 8, 7],
    // 9 days ago
    [theo, MEMBER, "task.created", "TASK", "Add dark mode toggle", "Created task “Add dark mode toggle” in Fernly Mobile App", 9, 4],
    [ingrid, MANAGER, "project.updated", "PROJECT", "Pulse Customer Portal", "Updated owner on project “Pulse Customer Portal”", 9, 2],
    [mira, ADMIN, "task.deleted", "TASK", "Fix dropdown z-index overlap", "Deleted task “Fix dropdown z-index overlap”", 9, 1],
  ];

  function fmt(d) {
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  for (const [actor, actorRole, action, entityType, entityLabel, detail, daysAgo, hoursAgo] of auditEntries) {
    await audit(actor, actorRole, action, entityType, entityLabel, detail, daysAgo, hoursAgo);
  }
  console.log(`  ✓ ${auditEntries.length} audit log entries across 10 days`);

  // -------------------------------------------------------------------------
  // Bug tracking seed — demo bugs across the full lifecycle so the Bugs
  // view has data to show. Reporter = QA (theo), assignee = developers.
  // -------------------------------------------------------------------------
  await db.bug.deleteMany();
  await db.bugComment.deleteMany();

  // Look up user IDs for reporter + assignee + a project for linking.
  const bugReporter = memberUser.id; // MEMBER (QA role in this demo)
  const bugAssignee1 = allUsers.find((u) => u.name === "Mira Hale") ?? allUsers[0];
  const bugAssignee2 = allUsers.find((u) => u.name === "Sam Chen") ?? allUsers[1];
  const bugProject = await db.project.findFirst({ select: { id: true, name: true } });

  const bugNow = new Date();
  function daysAgoDate(d) {
    const dt = new Date(bugNow);
    dt.setDate(dt.getDate() - d);
    return dt;
  }

  const bugSeed = [
    {
      title: "Login page crashes on Safari 17 when password autofill is used",
      description: "When a user with iCloud Keychain autofill submits the login form on Safari 17, the page crashes with a blank white screen. The crash does not happen on Chrome or Firefox.",
      stepsToReproduce: "1. Open Safari 17 on macOS 14\n2. Navigate to /login\n3. Let Keychain autofill the email + password\n4. Click Sign In\n5. Page goes blank",
      expectedBehavior: "User is redirected to the dashboard.",
      actualBehavior: "Page goes blank; console shows a React hydration error.",
      severity: "CRITICAL",
      priority: "P0",
      status: "IN_PROGRESS",
      reporterUserId: bugReporter,
      assigneeUserId: bugAssignee1.id,
      projectId: bugProject?.id ?? null,
      environment: "Production / Safari 17 / macOS 14",
      createdAt: daysAgoDate(3),
      triagedAt: daysAgoDate(2),
      comments: [
        { authorId: bugAssignee1.id, authorName: bugAssignee1.name, body: "Reproduced on Safari 17.1. Looks like the autofill event fires during hydration.", createdAt: daysAgoDate(2) },
        { authorId: bugReporter, authorName: "Theo Park", body: "Any update? This is blocking ~15% of our Safari users.", createdAt: daysAgoDate(1) },
        { authorId: bugAssignee1.id, authorName: bugAssignee1.name, body: "Working on a fix — will have a PR up today.", createdAt: daysAgoDate(0) },
      ],
    },
    {
      title: "Dashboard charts don't render on mobile viewport (375px)",
      description: "The Recharts area chart on the dashboard overflows horizontally on iPhone SE (375px). The chart container doesn't shrink to fit.",
      stepsToReproduce: "1. Open dashboard on iPhone SE\n2. Scroll to the analytics section\n3. Observe horizontal overflow",
      expectedBehavior: "Chart scales to fit the viewport.",
      actualBehavior: "Chart overflows; horizontal scrollbar appears.",
      severity: "MAJOR",
      priority: "P1",
      status: "RESOLVED",
      resolution: "FIXED",
      reporterUserId: bugReporter,
      assigneeUserId: bugAssignee2.id,
      projectId: bugProject?.id ?? null,
      environment: "Production / Chrome 120 / iPhone SE 375px",
      createdAt: daysAgoDate(5),
      triagedAt: daysAgoDate(4),
      resolvedAt: daysAgoDate(1),
      comments: [
        { authorId: bugAssignee2.id, authorName: bugAssignee2.name, body: "The chart container needs a `ResponsiveContainer` wrapper. Fix in PR #142.", createdAt: daysAgoDate(1) },
        { authorId: bugReporter, authorName: "Theo Park", body: "Verified on iPhone SE — no overflow. Looks good.", createdAt: daysAgoDate(0) },
      ],
    },
    {
      title: "Email field accepts trailing spaces on sign-up (but not sign-in)",
      description: "The sign-up form stores the email as-typed (with spaces), but the sign-in form trims. A user who signs up with ' ada@x.co ' cannot sign in.",
      stepsToReproduce: "1. Sign up with email ' ada@x.co ' (note spaces)\n2. Sign out\n3. Sign in with 'ada@x.co'\n4. Login fails",
      expectedBehavior: "Both forms normalize email the same way.",
      actualBehavior: "Sign-up stores with spaces; sign-in trims → mismatch.",
      severity: "MAJOR",
      priority: "P2",
      status: "TRIAGED",
      reporterUserId: bugReporter,
      assigneeUserId: null,
      projectId: null,
      environment: "Staging / Chrome 120 / macOS",
      createdAt: daysAgoDate(2),
      triagedAt: daysAgoDate(1),
      comments: [
        { authorId: bugReporter, authorName: "Theo Park", body: "This is likely a trim().toLowerCase() inconsistency between the two forms.", createdAt: daysAgoDate(2) },
      ],
    },
    {
      title: "Audit log page shows 'Loading…' forever when audit:view permission is revoked mid-session",
      description: "If a MANAGER's audit:view permission is revoked while they have the audit page open, the page shows 'Loading…' indefinitely. The 403 response is not surfaced.",
      stepsToReproduce: "1. MANAGER opens the audit page\n2. Admin revokes audit:view from MANAGER role\n3. MANAGER refreshes\n4. Page stuck on Loading…",
      expectedBehavior: "Show 'You do not have permission to view the audit log.'",
      actualBehavior: "Infinite loading spinner.",
      severity: "MINOR",
      priority: "P2",
      status: "NEW",
      reporterUserId: bugReporter,
      assigneeUserId: null,
      projectId: null,
      environment: "Production / Chrome 120 / macOS",
      createdAt: daysAgoDate(1),
      comments: [],
    },
    {
      title: "Calendar event tooltip shows wrong date when timezone is changed",
      description: "After changing the timezone in Settings, existing calendar event tooltips still show the old timezone until the page is hard-refreshed.",
      stepsToReproduce: "1. Set timezone to UTC\n2. Create an event at 14:00\n3. Change timezone to NZST (UTC+12)\n4. Hover over the event\n5. Tooltip still shows 14:00 UTC instead of 02:00 NZST",
      expectedBehavior: "Tooltip updates to reflect the new timezone immediately.",
      actualBehavior: "Stale until hard refresh.",
      severity: "MINOR",
      priority: "P3",
      status: "CLOSED",
      resolution: "WORKS_AS_INTENDED",
      reporterUserId: bugReporter,
      assigneeUserId: bugAssignee1.id,
      projectId: null,
      environment: "Production / Chrome 120 / macOS",
      createdAt: daysAgoDate(10),
      triagedAt: daysAgoDate(9),
      resolvedAt: daysAgoDate(7),
      closedAt: daysAgoDate(6),
      comments: [
        { authorId: bugAssignee1.id, authorName: bugAssignee1.name, body: "The tooltip caches the timezone at mount. This is expected — a hard refresh is the documented recovery.", createdAt: daysAgoDate(7) },
        { authorId: bugReporter, authorName: "Theo Park", body: "Fair enough. Closing as works-as-intended.", createdAt: daysAgoDate(6) },
      ],
    },
    {
      title: "Kanban drag-and-drop loses card position when dropped on empty column",
      description: "When dragging a task card to an empty column, the card briefly appears then snaps back to the original column. A second drag attempt succeeds.",
      stepsToReproduce: "1. Create an empty column (move all DONE tasks to IN_REVIEW)\n2. Drag a TODO task to the empty DONE column\n3. Card snaps back\n4. Drag again — succeeds",
      expectedBehavior: "First drop succeeds.",
      actualBehavior: "First drop fails; second succeeds.",
      severity: "MAJOR",
      priority: "P1",
      status: "REOPENED",
      reporterUserId: bugReporter,
      assigneeUserId: bugAssignee2.id,
      projectId: bugProject?.id ?? null,
      environment: "Production / Chrome 120 / macOS",
      createdAt: daysAgoDate(7),
      triagedAt: daysAgoDate(6),
      resolvedAt: daysAgoDate(3),
      comments: [
        { authorId: bugAssignee2.id, authorName: bugAssignee2.name, body: "Fixed in PR #138 — the DnD library needed `setNodeRef` on the empty column.", createdAt: daysAgoDate(3) },
        { authorId: bugReporter, authorName: "Theo Park", body: "Reopening — still happens on Firefox. The fix only covered Chrome.", createdAt: daysAgoDate(0) },
      ],
    },
    {
      title: "Password reset email subject line truncated in Outlook desktop client",
      description: "The subject 'Fernly — reset your password' is truncated to 'Fernly — reset your pa…' in Outlook desktop. Gmail and Apple Mail show it fine.",
      stepsToReproduce: "1. Request a password reset\n2. Open the email in Outlook desktop\n3. Subject is truncated",
      expectedBehavior: "Full subject visible.",
      actualBehavior: "Truncated at ~30 chars.",
      severity: "TRIVIAL",
      priority: "P3",
      status: "NEW",
      reporterUserId: bugReporter,
      assigneeUserId: null,
      projectId: null,
      environment: "Production / Outlook desktop / Windows 11",
      createdAt: daysAgoDate(0),
      comments: [],
    },
  ];

  for (const b of bugSeed) {
    const { comments, ...bugData } = b;
    const created = await db.bug.create({ data: { ...bugData, updatedAt: bugData.createdAt } });
    for (const c of comments) {
      await db.bugComment.create({
        data: { ...c, bugId: created.id },
      });
    }
    // Audit the bug creation (so the audit trail has the bug entries).
    await audit(
      memberUser,
      "MEMBER",
      "bug.created",
      "BUG",
      bugData.title,
      `Bug “${bugData.title}” raised (${bugData.severity}, ${bugData.priority})`,
      Math.floor((bugNow - bugData.createdAt) / (24 * 60 * 60 * 1000)),
      0,
    );
    if (bugData.status === "RESOLVED" || bugData.status === "CLOSED") {
      await audit(
        bugAssignee1,
        "MEMBER",
        "bug.resolved",
        "BUG",
        bugData.title,
        `Resolved as ${bugData.resolution ?? "FIXED"}`,
        Math.floor((bugNow - (bugData.resolvedAt ?? bugData.createdAt)) / (24 * 60 * 60 * 1000)),
        0,
      );
    }
    if (bugData.status === "CLOSED") {
      await audit(
        memberUser,
        "MEMBER",
        "bug.closed",
        "BUG",
        bugData.title,
        `Closed (${bugData.resolution ?? "FIXED"})`,
        Math.floor((bugNow - (bugData.closedAt ?? bugData.createdAt)) / (24 * 60 * 60 * 1000)),
        0,
      );
    }
    if (bugData.status === "REOPENED") {
      await audit(
        memberUser,
        "MEMBER",
        "bug.reopened",
        "BUG",
        bugData.title,
        "Reopened",
        0,
        0,
      );
    }
  }
  console.log(`  ✓ ${bugSeed.length} bugs seeded across all lifecycle states (NEW, TRIAGED, IN_PROGRESS, RESOLVED, CLOSED, REOPENED)`);

  console.log(`\n✅ Seed complete. Login: ${demoUser.email} / password from NEXT_PUBLIC_DEMO_PASSWORD (.env)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
