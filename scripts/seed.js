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
  await db.leaveRequest.deleteMany();
  await db.leaveBalance.deleteMany();
  await db.leaveLedgerEntry.deleteMany();
  await db.leavePolicy.deleteMany();
  await db.leaveType.deleteMany();
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
  await db.candidate.deleteMany();
  await db.mailOutbox.deleteMany();
  await db.hiringStageConfig.deleteMany();
  await db.documentTypeConfig.deleteMany();
  await db.onboardingTemplateTask.deleteMany();
  await db.offerTemplate.deleteMany();
  await db.offerRecord.deleteMany();
  await db.salaryStructure.deleteMany();
  await db.payrollRun.deleteMany(); // cascades payslips
  await db.holidayCalendarEntry.deleteMany();
  await db.attendanceRecord.deleteMany();

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
      // F2.10 — the joining gate (mandatory docs VERIFIED + terminal BGV
      // before markJoined). Default on; toggleable in Settings → General.
      joiningGateEnabled: true,
      // AT-B02/B03 (S2) — the reference day behind the late/early flags +
      // working hours. Defaults mirror the schema; explicit so the demo
      // story is self-documenting.
      attendanceDayStart: "09:00",
      attendanceDayEnd: "17:30",
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
    // QA-13 — the HR role existed in the RBAC matrix but NO user held it,
    // so every hr:* permission path (including the QA-11 reviewer gap)
    // was never exercised by any e2e. Seed one real People Ops account.
    { email: "remy@fernly.app", name: "Remy Laurent", role: "HR", timezone: "Europe/Paris", bio: "People Operations Lead. Runs onboarding and review cycles.", avatarColor: "plum" },
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
  // Reporting hierarchy (org chart) — 4-level chain rooted at the ADMIN.
  //   Mira (ADMIN, root)
  //     ├── Ingrid (MANAGER)        ← Engineering Manager
  //     │     ├── Lena (MEMBER)     ← backend lead (has a report, no role)
  //     │     │     └── Soren       ← QA (reports to Lena)   [QA-17]
  //     │     └── Rafael            ← DevOps
  //     ├── Priya (MANAGER)         ← Marketing Lead
  //     │     ├── Marcus            ← Content
  //     │     └── Hana              ← Design
  //     ├── Theo                    ← Frontend (reports to admin directly)
  //     ├── Yuki                    ← Product Designer
  //     ├── Amara                   ← UX Researcher
  //     └── Diego                   ← Full-stack
  //
  // QA-17: Soren reports to Lena (who reports to Ingrid) so the org chart
  // has a NON-ADMIN grand-manager — the only shape in which the plan-§6
  // "manager chain" reviewer scope is observable. Ingrid stays inside
  // the same subtree (queue scoping unchanged); Lena keeps her MEMBER
  // role (the org chart and RBAC are separate axes).
  // -----------------------------------------------------------------
  const mgrIngrid = userByName.get("Ingrid Solberg");
  const mgrPriya = userByName.get("Priya Nair");
  const lenaId = userByName.get("Lena Okafor");
  const treeAssignments = [
    ["Ingrid Solberg", demoUser.id],          // Ingrid → Mira
    ["Priya Nair", demoUser.id],              // Priya → Mira
    ["Lena Okafor", mgrIngrid],               // Lena → Ingrid
    ["Theo Vance", demoUser.id],              // Theo → Mira
    ["Yuki Tanaka", demoUser.id],
    ["Amara Diallo", demoUser.id],
    ["Diego Morales", demoUser.id],
    ["Soren Lindqvist", lenaId],              // QA-17: Soren → Lena → Ingrid
    ["Rafael Costa", mgrIngrid],
    ["Marcus Bell", mgrPriya],                // Marcus → Priya
    ["Hana Park", mgrPriya],
    ["Remy Laurent", demoUser.id],           // QA-13: HR reports to the admin
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
    // Project association rule — task assignees must be users associated
    // with the task's project. Staff the assignee explicitly so every seeded
    // task satisfies the invariant (and the assignee dropdown is never empty).
    if (assignee.userId) {
      await db.projectAssignment.upsert({
        where: { projectId_userId: { projectId: project.id, userId: assignee.userId } },
        create: { projectId: project.id, userId: assignee.userId, role: "MEMBER" },
        update: {},
      });
    }
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
  const bugProject = await db.project.findFirst({ select: { id: true, name: true, ownerUserId: true } });

  // Project association rule — every bug belongs to a project, and its
  // assignee must be a user associated with that project. Staff the reporter
  // + both demo assignees on the bug project explicitly so the seeded bugs
  // satisfy the invariant.
  if (bugProject) {
    for (const u of [bugReporter, bugAssignee1?.id, bugAssignee2?.id]) {
      if (!u) continue;
      await db.projectAssignment.upsert({
        where: { projectId_userId: { projectId: bugProject.id, userId: u } },
        create: {
          projectId: bugProject.id,
          userId: u,
          role: u === bugProject.ownerUserId ? "OWNER" : "MEMBER",
        },
        update: {},
      });
    }
  }

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
      projectId: bugProject?.id ?? "",
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
      projectId: bugProject?.id ?? "",
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
      projectId: bugProject?.id ?? "",
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
      projectId: bugProject?.id ?? "",
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
      projectId: bugProject?.id ?? "",
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
      projectId: bugProject?.id ?? "",
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
      projectId: bugProject?.id ?? "",
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

  // -------------------------------------------------------------------------
  // HR module seed — leave management (docs/HR_MODULE_PLAN.md). Deterministic
  // demo data for the e2e suite + the preview: three types with policies,
  // balances for the current year, and requests in every status.
  //
  // Approver wiring (single-approver rule): Theo (member@) reports to Mira
  // (ADMIN); Lena/Rafael/Soren report to Ingrid (manager@). So:
  //   • Theo's PENDING request is decided by demo@fernly.app (admin fallback)
  //   • Lena's PENDING request is decided by manager@fernly.app
  //   • Rafael's APPROVED leave covers TODAY+2..TODAY+6 (calendar + time guard)
  // -------------------------------------------------------------------------
  const YEAR = new Date().getUTCFullYear();

  // -------------------------------------------------------------------------
  // F1.1 — holiday calendar seed (docs/Fernly_HR_Payroll_Enhancement_Plan.md
  // §7.1). New Zealand national public holidays for the current + next year
  // (the demo workspace is Pacific/Auckland-based). Observed dates are used
  // when a holiday falls on a weekend (Mondayisation) — those are the dates
  // that actually remove working days. Regional anniversary days vary by
  // region and are deliberately NOT seeded. Sources: govt.nz /
  // employment.govt.nz holiday date lists (checked 2026-11-06).
  //
  // Years beyond this table seed nothing — an empty calendar simply means
  // Mon–Fri everywhere (the pre-F1.1 behavior).
  // -------------------------------------------------------------------------
  const NZ_PUBLIC_HOLIDAYS = {
    2026: [
      ["2026-01-01", "New Year's Day"],
      ["2026-01-02", "Day after New Year's Day"],
      ["2026-02-06", "Waitangi Day"],
      ["2026-04-03", "Good Friday"],
      ["2026-04-06", "Easter Monday"],
      ["2026-04-27", "ANZAC Day (observed)"],
      ["2026-06-01", "King's Birthday"],
      ["2026-07-10", "Matariki"],
      ["2026-10-26", "Labour Day"],
      ["2026-12-25", "Christmas Day"],
      ["2026-12-28", "Boxing Day (observed)"],
    ],
    2027: [
      ["2027-01-01", "New Year's Day"],
      ["2027-01-04", "Day after New Year's Day (observed)"],
      ["2027-02-08", "Waitangi Day (observed)"],
      ["2027-03-26", "Good Friday"],
      ["2027-03-29", "Easter Monday"],
      ["2027-04-26", "ANZAC Day (observed)"],
      ["2027-06-07", "King's Birthday"],
      ["2027-06-25", "Matariki"],
      ["2027-10-25", "Labour Day"],
      ["2027-12-27", "Christmas Day (observed)"],
      ["2027-12-28", "Boxing Day (observed)"],
    ],
  };
  const holidayEntries = [];
  for (const y of [YEAR, YEAR + 1]) {
    for (const [date, label] of NZ_PUBLIC_HOLIDAYS[y] ?? []) {
      holidayEntries.push({ date: new Date(`${date}T00:00:00.000Z`), label, isHalfDay: false, kind: "PUBLIC" });
    }
  }
  if (holidayEntries.length > 0) {
    await db.holidayCalendarEntry.createMany({ data: holidayEntries });
  }
  console.log(`  ✓ F1.1 holiday calendar: ${holidayEntries.length} NZ public holidays (${YEAR} + ${YEAR + 1})`);

  // Mirror of lib/working-days.ts workingDaysInPeriod — the seed must use
  // the SAME math as production ("seed mirrors production math"). Half-day
  // entries count 0.5 (none seeded today, but the mirror must be complete).
  const holidayKeyMap = new Map(holidayEntries.map((h) => [h.date.toISOString().slice(0, 10), h]));
  const workingDaysInPeriod = (period) => {
    const [y, m] = period.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0));
    let count = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
      const dow = cursor.getUTCDay();
      const hol = holidayKeyMap.get(cursor.toISOString().slice(0, 10));
      if (dow !== 0 && dow !== 6) {
        if (!hol) count += 1;
        else if (hol.isHalfDay) count += 0.5;
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return count;
  };
  const day = (offset) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offset);
    return d;
  };
  // Working-day offset helper: adds N Mon-Fri days to a base date.
  const workday = (base, n) => {
    const d = new Date(base);
    let added = 0;
    while (added < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) added += 1;
    }
    return d;
  };

  const annualType = await db.leaveType.create({
    data: {
      name: "Annual Leave", code: "ANNUAL", color: "#8b5cf6", paid: true, requiresDoc: false,
      policy: { create: { annualDays: 20, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15 } },
    },
    include: { policy: true },
  });
  const sickType = await db.leaveType.create({
    data: {
      name: "Sick Leave", code: "SICK", color: "#f59e0b", paid: true, requiresDoc: true,
      policy: { create: { annualDays: 10, maxCarryOver: 0, minNoticeDays: 0, maxConsecutiveDays: 120 } },
    },
    include: { policy: true },
  });
  const unpaidType = await db.leaveType.create({
    data: {
      name: "Unpaid Leave", code: "UNPAID", color: "#71717a", paid: false, requiresDoc: false,
      policy: { create: { annualDays: 0, maxCarryOver: 0, minNoticeDays: 2, maxConsecutiveDays: 30 } },
    },
    include: { policy: true },
  });
  // F2.4 — the strategy demo type (Org A of Fernly_Policy_Engine_Design.md
  // §4.2): earned monthly (24/year → 2 per month, granted on the 1st) with
  // advance leave allowed down to −5 days — "take advance leave, it is
  // added back monthly" made visible in the demo workspace.
  const advanceType = await db.leaveType.create({
    data: {
      name: "Advance Annual", code: "ADVANCE", color: "#0ea5e9", paid: true, requiresDoc: false,
      policy: {
        create: {
          annualDays: 24, maxCarryOver: 5, minNoticeDays: 1, maxConsecutiveDays: 15,
          allocationStrategy: "EARNED",
          accrualFrequency: "MONTHLY",
          allocateOnDay: "FIRST",
          accrualRounding: "FLOOR_QUARTER",
          accrualCap: null,
          grantOn: "PERIOD_START",
          prorateForJoiners: true,
          minServiceMonths: 0,
          accrueDuringProbation: true,
          allowNegative: true,
          negativeFloor: 5,
          carryExpiresAfterMonths: null,
          countHolidaysInLeave: false,
        },
      },
    },
    include: { policy: true },
  });

  const balanceFor = async (userId, type, entitled, used) => {
    await db.leaveBalance.create({
      data: { userId, leaveTypeId: type.id, year: YEAR, entitled, carriedOver: 0, used },
    });
  };
  // Everyone gets the full 20-day annual entitlement; Rafael already used 5.
  // The Advance Annual type accrues monthly — the seed mirrors what the
  // strategy would have granted by now (whole elapsed months × 2 days).
  const nowMonth = new Date().getUTCFullYear() === YEAR ? new Date().getUTCMonth() : 11;
  const advanceEntitled = Math.min(24, Math.max(0, (nowMonth + 1) * 2));
  for (const u of allUsers) {
    await balanceFor(u.id, annualType, 20, 0);
    await balanceFor(u.id, sickType, 10, 0);
    await balanceFor(u.id, unpaidType, 0, 0);
    await balanceFor(u.id, advanceType, advanceEntitled, 0);
  }
  const rafaelId = userByName.get("Rafael Costa");
  if (rafaelId) {
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: rafaelId, leaveTypeId: annualType.id, year: YEAR } },
      data: { used: 5 },
    });
  }
  // F2.1 — Soren's exit leave story: Annual 20 granted / 16 used (+4
  // encashable), Sick fully used (0 — keeps the demo card clean), and
  // Advance Annual taken 2 days AHEAD of accrual (−2, the FnF recovery
  // line). No request rows — the history predates the seed's request
  // stories, so the ledger writes BALANCE_IMPORT consumption rows (the
  // F1.2 backfill's source type) and the cache mirrors them.
  const sorenId = userByName.get("Soren Lindqvist");
  if (sorenId) {
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: sorenId, leaveTypeId: annualType.id, year: YEAR } },
      data: { used: 16 },
    });
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: sorenId, leaveTypeId: sickType.id, year: YEAR } },
      data: { used: 10 },
    });
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: sorenId, leaveTypeId: advanceType.id, year: YEAR } },
      data: { used: advanceEntitled + 2 },
    });
  }
  // Yuki's APPROVED single day (below) consumes 1 — the cache `used` must
  // match the request rows the F1.2 ledger backfills from (invariant:
  // used == -Σ CONSUME deltas).
  const yukiId = userByName.get("Yuki Tanaka");
  if (yukiId) {
    await db.leaveBalance.update({
      where: { userId_leaveTypeId_year: { userId: yukiId, leaveTypeId: annualType.id, year: YEAR } },
      data: { used: 1 },
    });
  }

  const leaveRequests = [];
  const mkRequest = async (userName, type, startOffset, endOffset, status, decidedBy, note, days) => {
    const userId = userByName.get(userName);
    if (!userId) return;
    const r = await db.leaveRequest.create({
      data: {
        userId,
        leaveTypeId: type.id,
        startDate: day(startOffset),
        endDate: day(endOffset),
        days,
        reason: note?.reason ?? "",
        status,
        decidedById: decidedBy ? userByName.get(decidedBy) ?? null : null,
        decidedAt: decidedBy ? new Date() : null,
        decisionNote: note?.decision ?? "",
      },
    });
    leaveRequests.push(r);
  };

  // Theo (reports to admin Mira) — PENDING, next week, 2 working days.
  await mkRequest("Theo Vance", annualType, 7, 8, "PENDING", null, { reason: "Family visit" }, 2);
  // Lena (reports to manager Ingrid) — PENDING, 3 working days.
  await mkRequest("Lena Okafor", annualType, 10, 14, "PENDING", null, { reason: "Conference trip" }, 3);
  // Rafael — APPROVED, covers TODAY+2..TODAY+6 (5 working days; used=5 matches).
  await mkRequest("Rafael Costa", annualType, 2, 6, "APPROVED", "Ingrid Solberg", { reason: "Wedding abroad", decision: "Approved — enjoy!" }, 5);
  // Yuki — APPROVED single day (TODAY+10), 1 day used.
  await mkRequest("Yuki Tanaka", annualType, 10, 10, "APPROVED", "Mira Hale", { reason: "Personal day" }, 1);
  // Marcus — REJECTED with a note (capacity).
  await mkRequest("Marcus Bell", unpaidType, 20, 27, "REJECTED", "Priya Nair", { reason: "Study sabbatical", decision: "Not this quarter — campaign launch." }, 6);
  // Amara — CANCELLED after approval (balance restored: used stays 0).
  await mkRequest("Amara Diallo", annualType, 30, 32, "CANCELLED", "Mira Hale", { reason: "Trip cancelled", decision: "" }, 3);
  // Soren — REJECTED sick-leave (no doc) as a documentation example.
  await mkRequest("Soren Lindqvist", sickType, -5, -5, "REJECTED", "Ingrid Solberg", { reason: "Migraine", decision: "No medical certificate attached." }, 1);

  // -------------------------------------------------------------------------
  // F1.2 — leave ledger seed (docs/Fernly_HR_Payroll_Enhancement_Plan.md
  // §7.1). Mirrors the production write paths exactly ("seed mirrors
  // production math"):
  //   • one GRANT row per materialized nonzero entitlement (the
  //     getOrCreateBalance/getOrCreateBalancesBatch twin);
  //   • one CONSUME row per APPROVED request (the approve-path twin);
  //   • Amara's cancelled-after-approval request gets BOTH the original
  //     consumption and its isReversal sibling (the cancel-path twin) —
  //     net zero, same as her seeded used=0.
  // Rafael's used=5 and Yuki's used=1 are reproduced by their CONSUME rows,
  // not by a cache-only update: the ledger IS the story.
  // -------------------------------------------------------------------------
  const grantRows = [];
  const grant = (userId, type, entitled) => {
    if (entitled === 0) return;
    grantRows.push({
      userId, leaveTypeId: type.id, year: YEAR, delta: entitled,
      entryType: "GRANT", sourceType: "POLICY", sourceId: type.id,
      note: `Annual entitlement ${YEAR} (${entitled} days)`, isReversal: false,
    });
  };
  for (const u of allUsers) {
    grant(u.id, annualType, 20);
    grant(u.id, sickType, 10);
    grant(u.id, unpaidType, 0);
    // F2.4 — EARNED strategy grants: one row per elapsed month, sourceId =
    // the deterministic period key (the cron job's idempotency input).
    for (let m = 0; m <= nowMonth; m++) {
      grantRows.push({
        userId: u.id, leaveTypeId: advanceType.id, year: YEAR, delta: 2,
        entryType: "GRANT", sourceType: "POLICY", sourceId: `${YEAR}-${String(m + 1).padStart(2, "0")}`,
        note: `Accrued 2 day(s) for ${YEAR}-${String(m + 1).padStart(2, "0")} (monthly earned leave)`,
        isReversal: false,
      });
    }
  }
  const consumeRows = [];
  for (const r of leaveRequests) {
    if (r.status !== "APPROVED" && r.status !== "CANCELLED") continue;
    // Only requests that were APPROVED at some point consume (the seed's
    // CANCELLED rows are all cancelled-after-approval — decidedBy set).
    if (!r.decidedById) continue;
    consumeRows.push({
      userId: r.userId, leaveTypeId: r.leaveTypeId, year: YEAR, delta: -r.days,
      entryType: "CONSUME", sourceType: "LEAVE_REQUEST", sourceId: r.id,
      note: `Seeded approved request (${r.days} d)`, isReversal: false,
    });
    if (r.status === "CANCELLED") {
      consumeRows.push({
        userId: r.userId, leaveTypeId: r.leaveTypeId, year: YEAR, delta: r.days,
        entryType: "CONSUME", sourceType: "LEAVE_REQUEST", sourceId: r.id,
        note: `Reversal: approved request cancelled (${r.days} d returned)`,
        isReversal: true,
      });
    }
  }
  // F2.1 — Soren's BALANCE_IMPORT consumption rows (the exit story above:
  // no request rows, so the ledger explains the cache directly).
  if (sorenId) {
    consumeRows.push(
      {
        userId: sorenId, leaveTypeId: annualType.id, year: YEAR, delta: -16,
        entryType: "CONSUME", sourceType: "BALANCE_IMPORT", sourceId: "",
        note: "Past usage seeded (16 d)", isReversal: false,
      },
      {
        userId: sorenId, leaveTypeId: sickType.id, year: YEAR, delta: -10,
        entryType: "CONSUME", sourceType: "BALANCE_IMPORT", sourceId: "",
        note: "Past usage seeded (10 d)", isReversal: false,
      },
      {
        userId: sorenId, leaveTypeId: advanceType.id, year: YEAR, delta: -(advanceEntitled + 2),
        entryType: "CONSUME", sourceType: "BALANCE_IMPORT", sourceId: "",
        note: "Advance leave taken ahead of accrual (2 d over)", isReversal: false,
      },
    );
  }
  if (grantRows.length || consumeRows.length) {
    await db.leaveLedgerEntry.createMany({
      data: [...grantRows, ...consumeRows],
    });
  }

  console.log(`  ✓ HR leave: 4 types + policies (incl. F2.4 EARNED advance type), balances for ${allUsers.length} users, ${leaveRequests.length} requests across all statuses (YEAR ${YEAR}); ledger: ${grantRows.length} GRANT + ${consumeRows.length} CONSUME/reversal rows`);

  // -------------------------------------------------------------------------
  // F1.3 — attendance seed (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.1).
  // Two sources, mirroring the production write paths exactly:
  //   1. DERIVED ON_LEAVE rows for every date of the APPROVED requests
  //      above (the seed-side twin of deriveOnLeaveAttendance in
  //      server-actions/hr-shared.ts — dates that already have a record
  //      are skipped, MANUAL wins; "seed mirrors production math").
  //   2. A few explicit MANUAL showcase rows around today so the HR grid
  //      and My Attendance have something to show on a fresh demo DB.
  // -------------------------------------------------------------------------
  const attendanceRows = [];
  const takenAttendance = new Set();
  const dayKeyOf = (d) => d.toISOString().slice(0, 10);
  for (const r of leaveRequests) {
    if (r.status !== "APPROVED") continue;
    for (let d = new Date(r.startDate); d <= r.endDate; d = new Date(d.getTime() + 86_400_000)) {
      const norm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const key = `${r.userId}|${dayKeyOf(norm)}`;
      if (takenAttendance.has(key)) continue;
      takenAttendance.add(key);
      attendanceRows.push({
        userId: r.userId,
        date: norm,
        status: "ON_LEAVE",
        note: `Derived from approved ${annualType.name} leave`,
        source: "DERIVED",
      });
    }
  }
  // Mirror of lib/attendance-flags.ts deriveAttendanceTiming — the seed
  // must use the SAME math as production ("seed mirrors production math").
  // Reference day: the workspace defaults above (09:00 / 17:30).
  const parseHm = (v) => {
    if (typeof v !== "string") return null;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const deriveTiming = (inTime, outTime) => {
    const dayStart = parseHm("09:00");
    const dayEnd = parseHm("17:30");
    const inMin = parseHm(inTime);
    const outMin = parseHm(outTime);
    return {
      lateMinutes: inMin !== null && dayStart !== null ? Math.max(0, inMin - dayStart) : null,
      earlyMinutes: outMin !== null && dayEnd !== null ? Math.max(0, dayEnd - outMin) : null,
      workingHours:
        inMin !== null && outMin !== null && outMin > inMin
          ? Math.round(((outMin - inMin) / 60) * 100) / 100
          : null,
    };
  };
  const manualAttendance = [
    ["Yuki Tanaka", -1, "WFH", "09:15", "17:40", "Design review from home"],
    ["Theo Vance", -1, "PRESENT", "09:00", "17:30", ""],
    ["Soren Lindqvist", -2, "ABSENT", null, null, "No show — follow-up sent"],
    ["Amara Diallo", -2, "HALF_DAY", "09:00", "13:00", "Morning only — school pickup"],
  ];
  for (const [userName, offset, status, inTime, outTime, note] of manualAttendance) {
    const userId = userByName.get(userName);
    if (!userId) continue;
    const d = day(offset);
    const key = `${userId}|${dayKeyOf(d)}`;
    // A derived ON_LEAVE row on the same day wins — one record per person
    // per day, and the derivation is authoritative for approved leave.
    if (takenAttendance.has(key)) continue;
    takenAttendance.add(key);
    // S2 — the timing facts ride on the row, mirroring the production
    // write path (upsertAttendanceRecord derives before storing).
    const timing = deriveTiming(inTime, outTime);
    attendanceRows.push({ userId, date: d, status, inTime, outTime, ...timing, note, source: "MANUAL" });
  }
  // F1.4 — Hana (a salary-structure holder) gets an ABSENT working day so
  // the current-month OPEN run has a genuine AUTO-derived LOP example next
  // to Yuki's manual showcase day. workday(TODAY, -2) is a guaranteed Mon-Fri
  // date, but NOT holiday-aware — when it lands on a seeded holiday the
  // derivation honestly charges 0 (that date-dependence is correct behavior,
  // not flakiness: nothing asserts Hana's LOP).
  {
    const hanaId = userByName.get("Hana Park");
    if (hanaId) {
      const d = workday(TODAY, -2);
      const key = `${hanaId}|${dayKeyOf(d)}`;
      if (!takenAttendance.has(key)) {
        takenAttendance.add(key);
        attendanceRows.push({
          userId: hanaId, date: d, status: "ABSENT", inTime: null, outTime: null,
          note: "No show — auto-LOP showcase", source: "MANUAL",
        });
      }
    }
  }
  if (attendanceRows.length > 0) {
    await db.attendanceRecord.createMany({ data: attendanceRows });
  }
  console.log(`  ✓ F1.3 attendance: ${attendanceRows.length} rows (derived ON_LEAVE from approved leave + current-month showcase marks incl. Hana's F1.4 auto-LOP day)`);

  // -------------------------------------------------------------------------
  // HR module seed — employee directory (docs/HR_MODULE_PLAN.md §5).
  // Job titles mirror the team roster; manager display resolves from the
  // org chart (User.managerId) at read time, not from these rows.
  // -------------------------------------------------------------------------
  await db.employeeProfile.deleteMany();
  // F1.6 — employment lifecycle (docs/Fernly_HR_Payroll_Enhancement_Plan.md
  // §7.1, decision §9.3). The migration backfills every profile WITH a
  // recorded hireDate to ACTIVE (a hire date is the strongest available
  // evidence of present employment); the seed mirrors that. Diego — the
  // seeded "new hire" with an in-progress onboarding — is the one
  // PROBATION example so the hard gate is explorable in the preview: HR
  // confirming him before his pending probation review completes is
  // refused; once manager@ (Ingrid) completes it, the confirmation passes.
  const probationSeed = new Map([
    ["Diego Morales", new Date("2026-12-15T00:00:00.000Z")],
  ]);
  const noticeSeed = new Map([
    ["Mira Hale", 8],
    ["Ingrid Solberg", 4],
    // F2.1 — the demo leaver carries a notice period for the exit card.
    ["Soren Lindqvist", 4],
  ]);
  // F2.1 — the offboarding story (docs/Fernly_HR_Payroll_Enhancement_Plan.md
  // §7.2): Soren is the demo leaver — EXITED with a last working day in
  // the current month (stepped back to a weekday), so the OPEN run's
  // payslip becomes the FnF's unprocessed-salary line and the rate basis
  // is a live period.
  const sorenLwd = day(-1);
  while (sorenLwd.getUTCDay() === 0 || sorenLwd.getUTCDay() === 6) {
    sorenLwd.setUTCDate(sorenLwd.getUTCDate() - 1);
  }
  const exitSeed = new Map([["Soren Lindqvist", sorenLwd]]);
  const profileSeed = [
    ["Mira Hale", "Founder & Workspace Admin", "MANAGEMENT", "2024-01-15", "Auckland, NZ", "+64 21 555 0001", "Strategy, hiring, coffee sourcing"],
    ["Ingrid Solberg", "Engineering Manager", "MANAGEMENT", "2024-03-04", "Oslo, Norway", "+47 405 55 002", "Team leadership, delivery, mentoring"],
    ["Theo Vance", "Senior Frontend Engineer", "ENGINEERING", "2024-06-10", "Auckland, NZ", "+64 21 555 0003", "React, TypeScript, accessibility"],
    ["Lena Okafor", "Backend Engineer", "ENGINEERING", "2024-08-19", "London, UK", "+44 7700 900004", "APIs, Postgres, performance tuning"],
    ["Rafael Costa", "DevOps Engineer", "ENGINEERING", "2025-01-27", "São Paulo, Brazil", "+55 11 95555 0005", "Kubernetes, Terraform, observability"],
    ["Yuki Tanaka", "Product Designer", "DESIGN", "2024-05-06", "Tokyo, Japan", "+81 90 5555 0006", "Design systems, prototyping, motion"],
    ["Amara Diallo", "UX Researcher", "DESIGN", "2024-10-14", "Dakar, Senegal", "+221 77 555 0007", "Interviews, usability testing, insights"],
    ["Soren Lindqvist", "QA Engineer", "ENGINEERING", "2025-02-03", "Stockholm, Sweden", "+46 70 555 0008", "Test automation, exploratory testing"],
    ["Priya Nair", "Marketing Lead", "MARKETING", "2024-04-22", "Kolkata, India", "+91 98xxxxxxx9", "Brand, storytelling, campaigns"],
    ["Marcus Bell", "Content Strategist", "MARKETING", "2025-03-17", "New York, USA", "+1 555 010 0010", "Copywriting, editorial planning"],
    ["Hana Park", "Visual Designer", "DESIGN", "2024-11-11", "Seoul, South Korea", "+82 10 5550 0011", "Illustration, brand identity, typography"],
    ["Diego Morales", "Mobile Engineer", "ENGINEERING", "2025-04-08", "Mexico City, Mexico", "+52 55 5555 0012", "React Native, offline-first, push"],
    ["Remy Laurent", "People Operations Lead", "MANAGEMENT", "2025-05-20", "Paris, France", "+33 6 55 55 01 13", "People ops, onboarding design, coaching"],
  ];
  let profileCount = 0;
  // EM-B01 (S13) — the employee-number series mirrors the migration's
  // deterministic backfill: EMP-0001… in profileSeed (createdAt) order.
  let empSeq = 0;
  for (const [name, jobTitle, department, hireDate, location, phone, skills] of profileSeed) {
    const uid = userByName.get(name);
    if (!uid) continue;
    empSeq += 1;
    await db.employeeProfile.create({
      data: {
        userId: uid,
        employeeNumber: `EMP-${String(empSeq).padStart(4, "0")}`,
        jobTitle,
        department,
        hireDate: new Date(`${hireDate}T00:00:00.000Z`),
        employmentStatus: exitSeed.has(name) ? "EXITED" : probationSeed.has(name) ? "PROBATION" : "ACTIVE",
        ...(probationSeed.has(name) ? { probationEndsAt: probationSeed.get(name) } : {}),
        ...(exitSeed.has(name) ? { lastWorkingDay: exitSeed.get(name) } : {}),
        ...(noticeSeed.has(name) ? { noticePeriodWeeks: noticeSeed.get(name) } : {}),
        location,
        phone,
        skills,
        emergencyContactName: "",
        emergencyContactPhone: "",
        notes: "",
      },
    });
    profileCount += 1;
  }
  console.log(`  ✓ HR directory: ${profileCount} employee profiles seeded (F1.6: ${profileCount - probationSeed.size - exitSeed.size} ACTIVE, ${probationSeed.size} PROBATION, ${exitSeed.size} EXITED)`);

  // -------------------------------------------------------------------------
  // HR module seed — performance reviews (docs/HR_MODULE_PLAN.md §6).
  // One cycle per lifecycle stage so every transition is demonstrable:
  //   • Theo (member@): DRAFT — self-service write + submit in e2e
  //   • Lena: SUBMITTED — manager@ (her manager) completes the review
  //   • Rafael: REVIEWED — he acknowledges in e2e
  //   • Yuki: ACKNOWLEDGED — terminal example with ratings on both sides
  // -------------------------------------------------------------------------
  await db.performanceReview.deleteMany();
  const YEAR_NOW = new Date().getUTCFullYear();
  const reviewSeed = [
    ["Theo Vance", "DRAFT", `${YEAR_NOW} Mid-year review`, "", null, "", null, null, null],
    ["Lena Okafor", "SUBMITTED", `${YEAR_NOW} Mid-year review`, "Shipped the billing API ahead of schedule; mentoring Amara.", 4, "", null, null, null],
    ["Rafael Costa", "REVIEWED", `${YEAR_NOW} Q1 check-in`, "Cut deploy times by 60% with the pipeline overhaul.", 4, "Reliability champion — keep leading incident reviews.", 5, "Ingrid Solberg"],
    ["Yuki Tanaka", "ACKNOWLEDGED", `${YEAR_NOW - 1} Annual review`, "Redesigned the design system; adoption at 90%.", 5, "Outstanding craft and collaboration.", 5, "Mira Hale"],
    // QA-13/QA-11 — a SUBMITTED cycle outside Ingrid's subtree (Amara
    // reports to Mira) that only ADMIN or the new HR user can review:
    // the e2e proves HR (not in Amara's chain) completes it.
    ["Amara Diallo", "SUBMITTED", `${YEAR_NOW} Q3 check-in`, "Ran 24 interviews and rebuilt the onboarding survey.", 4, "", null, null, null],
    // QA-17 — a DRAFT cycle for Soren (chain: Soren → Lena → Ingrid →
    // Mira). The e2e has Soren submit it and INGRID (the grand-manager,
    // not the immediate manager Lena) complete the review — the plan §6
    // "manager chain" scope the original one-level guard violated.
    ["Soren Lindqvist", "DRAFT", `${YEAR_NOW} Skip-level check-in`, "", null, "", null, null, null],
  ];
  for (const [name, status, title, selfAssessment, selfRating, managerComment, managerRating, reviewedBy, ] of reviewSeed) {
    const uid = userByName.get(name);
    if (!uid) continue;
    await db.performanceReview.create({
      data: {
        userId: uid,
        title,
        periodStart: new Date(`${YEAR_NOW}-01-01T00:00:00.000Z`),
        periodEnd: new Date(`${YEAR_NOW}-12-31T00:00:00.000Z`),
        status,
        selfAssessment,
        selfRating,
        managerComment,
        managerRating,
        reviewedById: reviewedBy ? userByName.get(reviewedBy) ?? null : null,
        reviewedAt: reviewedBy ? new Date() : null,
        acknowledgedAt: status === "ACKNOWLEDGED" ? new Date() : null,
      },
    });
  }
  // F1.6 — Diego's PROBATION-kind cycle, SUBMITTED so his manager (Ingrid,
  // manager@) can complete it in the preview demo; until then the §9.3
  // hard gate refuses his PROBATION → ACTIVE confirmation in the directory.
  await db.performanceReview.create({
    data: {
      userId: userByName.get("Diego Morales"),
      title: "2026 Probation review — Diego",
      kind: "PROBATION",
      periodStart: new Date("2026-11-02T00:00:00.000Z"),
      periodEnd: new Date("2026-12-15T00:00:00.000Z"),
      status: "SUBMITTED",
      selfAssessment: "First six weeks: shipped the offline-first prototype, ramped on the release pipeline, pairing with Rafael weekly.",
      selfRating: 4,
      managerComment: "",
      managerRating: null,
      reviewedById: null,
      reviewedAt: null,
      acknowledgedAt: null,
    },
  });
  console.log(`  ✓ HR reviews: ${reviewSeed.length + 1} cycles seeded (incl. Diego's pending PROBATION cycle — the §9.3 gate input)`);

  // -------------------------------------------------------------------------
  // HR module seed — onboarding (docs/HR_MODULE_PLAN.md §7). Diego is the
  // "new hire" (reports to Ingrid) with a template checklist in progress;
  // Hana's checklist is one task from completion for the auto-complete e2e.
  // -------------------------------------------------------------------------
  await db.onboardingChecklist.deleteMany();
  await db.onboardingTask.deleteMany();
  const diegoId = userByName.get("Diego Morales");
  const hanaId = userByName.get("Hana Park");
  const diegoChecklist = await db.onboardingChecklist.create({
    data: {
      newHireId: diegoId,
      title: "Nov 2026 onboarding — Diego",
      tasks: {
        create: [
          { title: "Sign the employment contract", assigneeId: null, dueOffsetDays: 1, order: 0, done: true, doneAt: new Date(), doneById: userByName.get("Remy Laurent") ?? null },
          { title: "Set up accounts and SSO access", assigneeId: null, dueOffsetDays: 2, order: 1 },
          { title: "Meet your manager for the 1:1 kick-off", assigneeId: userByName.get("Ingrid Solberg") ?? null, dueOffsetDays: 3, order: 2 },
          { title: "Complete the workspace tour", assigneeId: diegoId, dueOffsetDays: 5, order: 3 },
          { title: "First small task shipped with a mentor", assigneeId: diegoId, dueOffsetDays: 14, order: 4 },
        ],
      },
    },
  });
  // Unassigned manager tasks fall to the hire's manager (Ingrid).
  await db.onboardingTask.updateMany({
    where: { checklistId: diegoChecklist.id, assigneeId: null },
    data: { assigneeId: userByName.get("Ingrid Solberg") ?? null },
  });
  const hanaChecklist = await db.onboardingChecklist.create({
    data: {
      newHireId: hanaId,
      title: "Nov 2026 onboarding — Hana",
      tasks: {
        create: [
          { title: "Sign the employment contract", assigneeId: userByName.get("Priya Nair") ?? null, dueOffsetDays: 1, order: 0, done: true, doneAt: new Date(), doneById: userByName.get("Priya Nair") ?? null },
          { title: "Set up accounts and SSO access", assigneeId: userByName.get("Priya Nair") ?? null, dueOffsetDays: 2, order: 1, done: true, doneAt: new Date(), doneById: userByName.get("Priya Nair") ?? null },
          { title: "Meet your manager for the 1:1 kick-off", assigneeId: userByName.get("Priya Nair") ?? null, dueOffsetDays: 3, order: 2 },
        ],
      },
    },
  });
  console.log(`  ✓ HR onboarding: 2 checklists seeded (Diego in progress, Hana one task from completion)`);







  // Deterministic task for Rafael (time-guard e2e — hr-leave.feature): a
  // task assigned to HIM in a real project, so the task modal's time-log
  // form is reachable when signed in as rafael@fernly.app, and his approved
  // leave (TODAY+2..+6) blocks logging hours on those days.
  if (rafaelId) {
    const rafaelMember = await db.teamMember.findFirst({ where: { userId: rafaelId } });
    const guardProject = await db.project.findFirst({ select: { id: true } });
    if (rafaelMember && guardProject) {
      await db.projectAssignment.upsert({
        where: { projectId_userId: { projectId: guardProject.id, userId: rafaelId } },
        create: { projectId: guardProject.id, userId: rafaelId, role: "MEMBER" },
        update: {},
      });
      await db.task.create({
        data: {
          title: "Harden CI pipeline",
          description: "Deterministic e2e task for the HR leave time guard.",
          status: "IN_PROGRESS",
          priority: "MEDIUM",
          tag: "BACKEND",
          projectId: guardProject.id,
          assigneeId: rafaelMember.id,
          order: 999,
        },
      });
      console.log("  ✓ HR leave: Rafael's time-guard task + project staffing");
    }
  }



  // -----------------------------------------------------------------
  // Recruitment module — hiring pipeline seed (docs/RECRUITMENT_MODULE_PLAN.md).
  // Stage template defaults mirror the researched 7-step funnel (§1.2A);
  // candidates snapshot the template exactly like createCandidate does.
  // -----------------------------------------------------------------
  const STAGE_TEMPLATE = [
    { key: "screening", label: "Application Screening", stageType: "SCREENING", ownerRole: "HR", description: "Resume + phone screen; reduce the pool", sortOrder: 10 },
    { key: "interview_1", label: "Interview 1 — Technical", stageType: "INTERVIEW", ownerRole: "MANAGER", description: "Role suitability, structured (STAR)", sortOrder: 20 },
    { key: "interview_2", label: "Interview 2 — HR & Culture", stageType: "INTERVIEW", ownerRole: "HR", description: "Values, communication, team fit", sortOrder: 30 },
    { key: "assessment", label: "Assessment / Work Sample", stageType: "ASSESSMENT", ownerRole: "HR", description: "Optional work sample or test task", sortOrder: 40 },
    { key: "bg_check", label: "Background Check", stageType: "BG_CHECK", ownerRole: "HR", description: "Trigger on offer acceptance (research B)", sortOrder: 50 },
    { key: "documents", label: "Document Collection", stageType: "DOCUMENTS", ownerRole: "HR", description: "ID, bank, education, experience letters", sortOrder: 60 },
    { key: "offer", label: "Offer & Signature", stageType: "OFFER", ownerRole: "HR", description: "Offer letter + e-signature", sortOrder: 70 },
  ];
  for (const s of STAGE_TEMPLATE) {
    await db.hiringStageConfig.create({ data: s });
  }

  const managerIdForInterviews = managerUser.id;
  const hrUserId = (await db.user.findUnique({ where: { email: "remy@fernly.app" }, select: { id: true } }))?.id ?? null;
  // (stageKey, status) per candidate — the timeline shape per person.
  const CANDIDATES = [
    {
      fullName: "Nadia Petrova", email: "nadia.petrova@example.com", phone: "+64 21 555 0101",
      position: "Senior Frontend Engineer", department: "ENGINEERING", source: "Referral",
      notes: "Strong React + a11y background; referred by Ingrid.",
      progress: [["screening", "PASSED"], ["interview_1", "PASSED"], ["interview_2", "IN_PROGRESS"]],
      // R2 — next loop scheduled with Ingrid; interview_1 scorecard filled.
      scheduled: { interview_2: addHours(TODAY, 72) },
      scorecard: {
        interview_1: {
          rating: 4, recommendation: "HIRE",
          strengths: "Deep React + a11y knowledge; clear communicator; strong system-design instincts.",
          concerns: "Limited backend exposure — pair on API work early.",
        },
      },
    },
    {
      fullName: "Sam Whitaker", email: "sam.whitaker@example.com", phone: "+64 22 555 0102",
      position: "Backend Engineer", department: "ENGINEERING", source: "Job board",
      notes: "Go + Postgres; take-home pending.",
      progress: [["screening", "PASSED"], ["interview_1", "IN_PROGRESS"]],
      scheduled: { interview_1: addHours(TODAY, 96) },
    },
    {
      fullName: "Priyanka Menon", email: "priyanka.menon@example.com", phone: "+64 27 555 0103",
      position: "Product Designer", department: "DESIGN", source: "Website",
      notes: "Great portfolio; cleared the full loop — selected, offer prep pending.",
      // R3 — selected after the full loop; waits for the offer builder (R5).
      status: "SELECTED",
      progress: [["screening", "PASSED"], ["interview_1", "PASSED"], ["interview_2", "PASSED"], ["assessment", "PASSED"]],
    },
    {
      fullName: "Tomas Eriksen", email: "tomas.eriksen@example.com", phone: "+64 3 555 0104",
      position: "QA Engineer", department: "ENGINEERING", source: "Agency",
      notes: "Screening call done — scheduling tech interview.",
      progress: [["screening", "PASSED"], ["interview_1", "PENDING"]],
    },
    {
      fullName: "Aisha Rahman", email: "aisha.rahman@example.com", phone: "+64 21 555 0105",
      position: "Content Strategist", department: "MARKETING", source: "Referral",
      notes: "Fresh applicant.",
      progress: [["screening", "IN_PROGRESS"]],
    },
    {
      fullName: "Vikram Singh", email: "vikram.singh@example.com", phone: "+64 29 555 0106",
      position: "DevOps Engineer", department: "ENGINEERING", source: "Job board",
      notes: "Withdrew — accepted another offer.",
      status: "WITHDRAWN",
      progress: [["screening", "PASSED"], ["interview_1", "PASSED"]],
    },
    {
      fullName: "Elena Moreau", email: "elena.moreau@example.com", phone: "+64 22 555 0107",
      position: "Backend Engineer", department: "ENGINEERING", source: "Job board",
      notes: "Rejected after technical loop — fundamentals gap.",
      status: "REJECTED",
      rejectReason: "Technical depth below the bar for the seniority level.",
      progress: [["screening", "PASSED"], ["interview_1", "FAILED"]],
    },
  ];
  for (const c of CANDIDATES) {
    await db.candidate.create({
      data: {
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
        position: c.position,
        department: c.department,
        source: c.source,
        notes: c.notes,
        status: c.status ?? "ACTIVE",
        rejectReason: c.rejectReason ?? "",
        createdById: demoUser.id,
        decidedAt: c.status && c.status !== "ACTIVE" ? addDays(TODAY, -2) : null,
        stages: {
          create: STAGE_TEMPLATE.map((t) => {
            const own = (c.progress ?? []).find(([k]) => k === t.key);
            const status = own ? own[1] : "PENDING";
            return {
              stageKey: t.key,
              label: t.label,
              stageType: t.stageType,
              ownerUserId: t.ownerRole === "MANAGER" ? managerIdForInterviews : hrUserId,
              status,
              remarks: (c.scorecard ?? {})[t.key]?.remarks ?? "",
              rating: (c.scorecard ?? {})[t.key]?.rating ?? null,
              strengths: (c.scorecard ?? {})[t.key]?.strengths ?? "",
              concerns: (c.scorecard ?? {})[t.key]?.concerns ?? "",
              recommendation: (c.scorecard ?? {})[t.key]?.recommendation ?? null,
              scheduledAt: (c.scheduled ?? {})[t.key] ?? null,
              sortOrder: t.sortOrder,
              startedAt: status !== "PENDING" ? addDays(TODAY, -5) : null,
              completedAt: status === "PASSED" || status === "FAILED" ? addDays(TODAY, -3) : null,
            };
          }),
        },
      },
    });
  }
  // R2 — scheduled interviews also appear on the shared Calendar + as
  // personal reminders for the interviewer (exactly what scheduleInterview
  // creates in the app). F-R18 (S18) — the calendar event rides the same
  // basis the action now writes: UTC-midnight of the interview's calendar
  // day + the wall-clock HH:MM (the seed "user" is the server itself, so
  // the label is the instant's own UTC rendering); the reminder keeps the
  // true instant.
  for (const c of CANDIDATES) {
    for (const [key, when] of Object.entries(c.scheduled ?? {})) {
      const d = when instanceof Date ? when : new Date(when);
      const pad = (n) => String(n).padStart(2, "0");
      const eventDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const eventTime = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      await db.calendarEvent.create({
        data: {
          title: `Interview: ${c.fullName} — ${STAGE_TEMPLATE.find((t) => t.key === key)?.label ?? key}`,
          description: `${c.position || "Position n/a"} · ${c.email}`,
          date: eventDay,
          time: eventTime,
          durationMin: 60,
          type: "MEETING",
        },
      });
      await db.reminder.create({
        data: {
          title: `Interview with ${c.fullName}`,
          dueDate: d,
          ownerId: managerIdForInterviews,
        },
      });
    }
  }
  // R3 — MailOutbox seed: the rejection email HR sent to Elena (delivered
  // via Resend in this story). New sends from the sandbox preview (no
  // RESEND_API_KEY) land as SKIPPED — the dry-run state is self-demoing.
  {
    const elena = await db.candidate.findUnique({ where: { email: "elena.moreau@example.com" } });
    if (elena) {
      await db.mailOutbox.create({
        data: {
          kind: "REJECTION",
          candidateId: elena.id,
          toAddress: elena.email,
          subject: "Update on your application — Backend Engineer at Fernly Workspace",
          body:
            "Hi Elena,\n\n" +
            "Thank you for taking the time to apply for the Backend Engineer role at Fernly Workspace and for meeting our team.\n\n" +
            "After careful consideration, we have decided not to move forward with your application at this time.\n" +
            "We were impressed by your API design work and would gladly consider you for mid-level backend openings next quarter.\n\n" +
            "We appreciate your interest in Fernly Workspace and wish you the very best in your search.\n\n" +
            "Warm regards,\nThe Fernly Workspace Hiring Team",
          status: "SENT",
          sentById: hrUserId ?? demoUser.id,
          sentAt: addDays(TODAY, -2),
          providerMessageId: "seed-demo-000001",
        },
      });
    }
  }
  // F2.10 (F-R10) — an interview-invite email in the outbox: Sam
  // Whitaker's interview_1 invite (SKIPPED — the sandbox preview has no
  // RESEND_API_KEY, exactly like every live send from it).
  {
    const sam = await db.candidate.findUnique({ where: { email: "sam.whitaker@example.com" } });
    const when = (sam ? (CANDIDATES.find((c) => c.email === sam.email)?.scheduled ?? {}) : {})["interview_1"];
    if (sam && when) {
      const d = when instanceof Date ? when : new Date(when);
      const whenLabel = d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
      await db.mailOutbox.create({
        data: {
          kind: "INTERVIEW_INVITE",
          candidateId: sam.id,
          toAddress: sam.email,
          subject: `Interview invitation — ${sam.position || "the role"} at Fernly Workspace`,
          body:
            `Hi Sam,\n\n` +
            `Thank you for your continued application for the ${sam.position || "Backend Engineer"} role at Fernly Workspace.\n` +
            `We would like to invite you to an interview:\n\n` +
            `  Stage: Interview 1 — Tech\n` +
            `  When: ${whenLabel} (60 minutes)\n` +
            `  With: Ingrid Solberg\n\n` +
            `If the time does not work, just reply to this email and we will find another slot.\n\n` +
            `Looking forward to speaking with you!\n\n` +
            `Warm regards,\nThe Fernly Workspace Hiring Team`,
          status: "SKIPPED",
          sentById: hrUserId ?? demoUser.id,
          sentAt: addDays(TODAY, -1),
        },
      });
    }
  }
  console.log(`  ✓ Hiring R2: ${CANDIDATES.reduce((n, c) => n + Object.keys(c.scheduled ?? {}).length, 0)} interviews scheduled on the calendar + 1 filled scorecard`);
  console.log(`  ✓ Hiring R3: 1 selected candidate (offer prep) + 1 rejection email in the outbox`);
  console.log(`  ✓ Hiring: ${STAGE_TEMPLATE.length}-stage template + ${CANDIDATES.length} candidates (4 active, 1 selected, 1 rejected, 1 withdrawn)`);

  // -----------------------------------------------------------------
  // R4 — joining formalities: document-type template + Priyanka's
  // checklist (SELECTED → offer accepted story) + a BGV in review.
  // -----------------------------------------------------------------
  const DOC_TYPES = [
    { key: "id_proof", label: "ID Document", description: "Passport or national ID (photo page)", isMandatory: true, sortOrder: 10 },
    { key: "bank_details", label: "Bank Details", description: "Account for salary deposits", isMandatory: true, sortOrder: 20 },
    { key: "right_to_work", label: "Right to Work", description: "Visa / citizenship evidence", isMandatory: true, sortOrder: 30 },
    { key: "education_certificates", label: "Education Certificates", description: "Highest qualification transcripts", isMandatory: false, sortOrder: 40 },
    { key: "previous_employment_proof", label: "Previous Employment Proof", description: "Relieving / service letters", isMandatory: false, sortOrder: 50 },
  ];
  for (const t of DOC_TYPES) {
    await db.documentTypeConfig.create({ data: t });
  }
  {
    const priyanka = await db.candidate.findUnique({ where: { email: "priyanka.menon@example.com" } });
    if (priyanka) {
      const hrId = (await db.user.findUnique({ where: { email: "remy@fernly.app" }, select: { id: true } }))?.id ?? "";
      await db.candidateDocument.createMany({
        data: [
          { candidateId: priyanka.id, docTypeKey: "id_proof", label: "ID Document", status: "VERIFIED", fileRef: "passport_menon.pdf", verifiedById: hrId, verifiedAt: addDays(TODAY, -3), receivedAt: addDays(TODAY, -4) },
          { candidateId: priyanka.id, docTypeKey: "bank_details", label: "Bank Details", status: "RECEIVED", fileRef: "bank_form_menon.pdf", receivedAt: addDays(TODAY, -1) },
          { candidateId: priyanka.id, docTypeKey: "right_to_work", label: "Right to Work", status: "REQUESTED" },
          { candidateId: priyanka.id, docTypeKey: "previous_employment_proof", label: "Previous Employment Proof", status: "REJECTED", fileRef: "relieving_letter.pdf", remarks: "Letter is dated after the stated last working day — please request a corrected copy.", receivedAt: addDays(TODAY, -2) },
        ],
      });
      await db.backgroundCheck.create({
        data: {
          candidateId: priyanka.id,
          vendor: "VerifyRight",
          status: "IN_REVIEW",
          notes: "Employment + education verification; ETA 5 business days.",
          initiatedById: hrId,
          initiatedAt: addDays(TODAY, -6),
        },
      });
    }
  }
  console.log(`  ✓ Hiring R4: ${DOC_TYPES.length} document types + Priyanka's checklist (1 verified, 1 received, 1 requested, 1 rejected) + BGV in review`);

  // -----------------------------------------------------------------
  // F2.10 (F-R8) — the ONE onboarding template source: the canonical
  // 5+5 tasks as table rows (both kinds). markJoined and createChecklist
  // instantiate from these; the constants in lib/onboarding-template.ts
  // are only the empty-table fallback.
  // -----------------------------------------------------------------
  const ONBOARDING_TEMPLATE_TASKS = [
    { kind: "ONBOARDING", title: "Sign the employment contract", dueOffsetDays: 1, assignSelf: false, sortOrder: 10 },
    { kind: "ONBOARDING", title: "Set up accounts and SSO access", dueOffsetDays: 2, assignSelf: false, sortOrder: 20 },
    { kind: "ONBOARDING", title: "Meet your manager for the 1:1 kick-off", dueOffsetDays: 3, assignSelf: false, sortOrder: 30 },
    { kind: "ONBOARDING", title: "Complete the workspace tour", dueOffsetDays: 5, assignSelf: true, sortOrder: 40 },
    { kind: "ONBOARDING", title: "First small task shipped with a mentor", dueOffsetDays: 14, assignSelf: true, sortOrder: 50 },
    { kind: "SEPARATION", title: "Hand over ongoing work and documents", dueOffsetDays: 3, assignSelf: true, sortOrder: 10 },
    { kind: "SEPARATION", title: "Return laptop and access devices", dueOffsetDays: 5, assignSelf: true, sortOrder: 20 },
    { kind: "SEPARATION", title: "Revoke accounts, SSO and tool access", dueOffsetDays: 5, assignSelf: false, sortOrder: 30 },
    { kind: "SEPARATION", title: "Hold the exit interview", dueOffsetDays: 7, assignSelf: false, sortOrder: 40 },
    { kind: "SEPARATION", title: "Settle the full-and-final statement", dueOffsetDays: 10, assignSelf: false, sortOrder: 50 },
  ];
  await db.onboardingTemplateTask.createMany({
    data: ONBOARDING_TEMPLATE_TASKS.map((t) => ({ ...t, isActive: true })),
  });
  console.log(`  ✓ F2.10: onboarding template source seeded (${ONBOARDING_TEMPLATE_TASKS.length} rows — 5 onboarding + 5 separation)`);

  // -----------------------------------------------------------------
  // R5 — offer templates (NZ flavour: KiwiSaver 3% employer contribution
  // as the percent-of-basic EMPLOYER_CONTRIBUTION showcase) + a DRAFT
  // offer generated for Priyanka from the designer template.
  // -----------------------------------------------------------------
  const OFFER_COMPONENTS_SENIOR = [
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78000 },
    { key: "housing", label: "Housing Allowance", kind: "EARNING", mode: "FIXED", amount: 12000 },
    { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 3000 },
    { key: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
  ];
  const LETTER = [
    "Dear {{candidateName}},",
    "",
    "We are delighted to offer you the position of {{position}} at {{workspaceName}}.",
    "Your annual package: total cost to company {{annualCtc}} (net take-home {{netPay}}).",
    "Proposed start date: {{startDate}}.",
    "",
    "Warm regards,",
    "The {{workspaceName}} Hiring Team",
  ].join("\n");
  const OFFER_TEMPLATES = [
    {
      key: "senior_engineer", label: "Senior Engineer Band", description: "Senior IC engineering band (NZD, annual)",
      components: OFFER_COMPONENTS_SENIOR,
      benefits: ["5 weeks annual leave", "NZD 2,000 training budget", "Full health insurance"],
      letterTemplate: LETTER, sortOrder: 10,
    },
    {
      key: "designer", label: "Designer Band", description: "Product/UX designer band (NZD, annual)",
      components: [
        { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68000 },
        { key: "housing", label: "Housing Allowance", kind: "EARNING", mode: "FIXED", amount: 10000 },
        { key: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
      ],
      benefits: ["4 weeks annual leave", "NZD 1,500 conference budget"],
      letterTemplate: LETTER, sortOrder: 20,
    },
    {
      key: "qa_engineer", label: "QA Engineer Band", description: "Quality engineering band (NZD, annual)",
      components: [
        { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 58000 },
        { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 2400 },
        { key: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
      ],
      benefits: ["4 weeks annual leave"],
      letterTemplate: LETTER, sortOrder: 30,
    },
  ];
  for (const t of OFFER_TEMPLATES) {
    await db.offerTemplate.create({
      data: {
        key: t.key, label: t.label, description: t.description,
        components: JSON.stringify(t.components),
        benefits: JSON.stringify(t.benefits),
        letterTemplate: t.letterTemplate,
        sortOrder: t.sortOrder,
      },
    });
  }
  {
    const priyanka = await db.candidate.findUnique({ where: { email: "priyanka.menon@example.com" } });
    const designerTpl = await db.offerTemplate.findUnique({ where: { key: "designer" } });
    if (priyanka && designerTpl) {
      const hrId = (await db.user.findUnique({ where: { email: "remy@fernly.app" }, select: { id: true } }))?.id ?? "";
      // F2.10 (F-R11) — a real negotiated start date ~3 weeks out; the
      // letter's {{startDate}} placeholder renders it (it used to be blank).
      const startDate = addDays(TODAY, 21);
      const startLabel = startDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      const comps = JSON.parse(designerTpl.components);
      const basic = comps.find((cp) => cp.key === "basic").amount;
      const ctc = comps.reduce((sum, cp) => sum + (cp.mode === "PERCENT_OF_BASIC" ? (basic * cp.amount) / 100 : cp.amount), 0);
      const earnings = comps.filter((cp) => cp.kind === "EARNING").reduce((sum, cp) => sum + (cp.mode === "PERCENT_OF_BASIC" ? (basic * cp.amount) / 100 : cp.amount), 0);
      const letter = designerTpl.letterTemplate
        .replace(/{{candidateName}}/g, priyanka.fullName)
        .replace(/{{position}}/g, priyanka.position || "Product Designer")
        .replace(/{{workspaceName}}/g, "Fernly Workspace")
        .replace(/{{startDate}}/g, startLabel)
        .replace(/{{annualCtc}}/g, `$${Math.round(ctc).toLocaleString("en-NZ")}`)
        .replace(/{{netPay}}/g, `$${Math.round(earnings).toLocaleString("en-NZ")}`);
      await db.offerRecord.create({
        data: {
          candidateId: priyanka.id,
          templateId: designerTpl.id,
          templateLabel: designerTpl.label,
          components: designerTpl.components,
          benefits: designerTpl.benefits,
          letterText: letter,
          startDate,
          status: "DRAFT",
          notes: `Negotiated start ${startLabel}; numbers match the band.`,
          createdById: hrId,
        },
      });
      // F2.10 (F-R5) — an older attempt whose signing link lapsed: the
      // funnel counts it as expired (never "awaiting"), the offers panel
      // shows the EXPIRED chip with the honest hint.
      const qaTpl = await db.offerTemplate.findUnique({ where: { key: "qa_engineer" } });
      if (qaTpl) {
        const qaComps = JSON.parse(qaTpl.components);
        const qaBasic = qaComps.find((cp) => cp.key === "basic").amount;
        const qaCtc = qaComps.reduce((sum, cp) => sum + (cp.mode === "PERCENT_OF_BASIC" ? (qaBasic * cp.amount) / 100 : cp.amount), 0);
        const qaEarnings = qaComps.filter((cp) => cp.kind === "EARNING").reduce((sum, cp) => sum + (cp.mode === "PERCENT_OF_BASIC" ? (qaBasic * cp.amount) / 100 : cp.amount), 0);
        await db.offerRecord.create({
          data: {
            candidateId: priyanka.id,
            templateId: qaTpl.id,
            templateLabel: qaTpl.label,
            components: qaTpl.components,
            benefits: qaTpl.benefits,
            letterText: qaTpl.letterTemplate
              .replace(/{{candidateName}}/g, priyanka.fullName)
              .replace(/{{position}}/g, priyanka.position || "Product Designer")
              .replace(/{{workspaceName}}/g, "Fernly Workspace")
              .replace(/{{startDate}}/g, startLabel)
              .replace(/{{annualCtc}}/g, `$${Math.round(qaCtc).toLocaleString("en-NZ")}`)
              .replace(/{{netPay}}/g, `$${Math.round(qaEarnings).toLocaleString("en-NZ")}`),
            startDate,
            status: "EXPIRED",
            notes: "First attempt (QA band) — the signing link expired; renegotiated on the designer band.",
            createdById: hrId,
            token: "seed-expired-offer-token-0000000000000000",
            tokenExpiresAt: addDays(TODAY, -2),
          },
        });
      }
    }
  }
  console.log(`  ✓ Hiring R5: ${OFFER_TEMPLATES.length} offer templates + Priyanka's draft offer (designer band, start date set) + 1 expired earlier attempt`);
  console.log(`  ✓ Hiring R6 ready: send the draft from the offer builder — the public /offer/<token> page collects the signature, then "Mark joined" provisions the account`);

  // -----------------------------------------------------------------
  // R7 — payroll seed: salary structures for the leadership team, a LOCKED
  // run for last month (paid, YTD baseline) and an OPEN run for this month
  // with one LOP-adjusted payslip. Monthly = annual ÷ 12 (same math as the
  // actions, lib/payroll-math.ts).
  // -----------------------------------------------------------------
  await db.salaryStructure.deleteMany();
  await db.payrollRun.deleteMany(); // cascades payslips
  await db.salaryComponent.deleteMany();
  {
    // F1.5 — the salary component catalog: the curated vocabulary behind the
    // structure editor's picker. Seeded with every code the demo workspace
    // actually pays (structure lines + Hana's bonus payslip line) plus one
    // retired row to show the lifecycle — mirroring what the F1.5 migration
    // backfills on a production DB (templates + structures first-sighting).
    const CATALOG_SEEDS = [
      { code: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", defaultAmount: 84_000, sortOrder: 10 },
      { code: "housing", label: "Housing Allowance", kind: "EARNING", mode: "FIXED", defaultAmount: 12_000, sortOrder: 20 },
      { code: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", defaultAmount: 2_400, sortOrder: 30 },
      { code: "bonus", label: "Performance Bonus", kind: "EARNING", mode: "FIXED", defaultAmount: 6_000, sortOrder: 40 },
      { code: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", defaultAmount: 3, sortOrder: 50 },
      { code: "student_loan", label: "Student Loan Repayment", kind: "DEDUCTION", mode: "FIXED", defaultAmount: 2_600, sortOrder: 60 },
      // A retired definition: still readable in the catalog list (struck
      // through), never offered by the picker. Structures that used it keep
      // their snapshot copies regardless.
      { code: "relocation", label: "Relocation Allowance", kind: "EARNING", mode: "FIXED", defaultAmount: 5_000, isActive: false, sortOrder: 70 },
    ];
    await db.salaryComponent.createMany({
      data: CATALOG_SEEDS.map((c) => ({
        code: c.code,
        label: c.label,
        kind: c.kind,
        mode: c.mode,
        defaultAmount: c.defaultAmount,
        isActive: c.isActive ?? true,
        sortOrder: c.sortOrder,
      })),
    });
    const round2 = (n) => Math.round(n * 100) / 100;
    const hrId = (await db.user.findUnique({ where: { email: "remy@fernly.app" }, select: { id: true } }))?.id ?? "";
    const STRUCTURE_SEEDS = [
      {
        email: "manager@fernly.app",
        components: [
          { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 96_000 },
          { key: "housing", label: "Housing Allowance", kind: "EARNING", mode: "FIXED", amount: 12_000 },
          { key: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
        ],
        notes: "Engineering lead band, reviewed 2026.",
      },
      {
        email: "hana@fernly.app",
        components: [
          { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 84_000 },
          { key: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
        ],
        notes: "Marketing lead, includes 2026 market adjustment.",
      },
      {
        email: "yuki@fernly.app",
        components: [
          { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 78_000 },
          { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 2_400 },
          { key: "kiwisaver", label: "KiwiSaver (employer 3%)", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
        ],
        notes: "Data engineering band.",
      },
      // F2.1 — the demo leaver holds a structure so his OPEN-run payslip
      // (monthly gross 5,200) feeds the FnF's unprocessed-salary line and
      // the encashment daily rate.
      {
        email: "soren@fernly.app",
        components: [
          { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 60_000 },
          { key: "transport", label: "Transport Allowance", kind: "EARNING", mode: "FIXED", amount: 2_400 },
        ],
        notes: "QA band — final structure (exit seeded, F2.1).",
      },
    ];
    const structures = [];
    for (const s of STRUCTURE_SEEDS) {
      const user = await db.user.findUnique({ where: { email: s.email }, select: { id: true, name: true } });
      if (!user) continue;
      const row = await db.salaryStructure.create({
        data: {
          userId: user.id,
          components: JSON.stringify(s.components),
          notes: s.notes,
          effectiveFrom: addDays(TODAY, -120),
          isActive: true,
          createdById: hrId,
        },
      });
      structures.push({ user, row, components: s.components });
    }

    // Monthly earnings from a structure (mirrors monthlyEarningsFromStructure).
    const monthlyLines = (components) => {
      const basic = components.find((c) => c.key.toLowerCase() === "basic")?.amount ?? 0;
      return components
        .filter((c) => c.kind === "EARNING")
        .map((c) => ({
          key: c.key,
          label: c.label,
          amount: round2((c.mode === "PERCENT_OF_BASIC" ? (basic * c.amount) / 100 : c.amount) / 12),
        }));
    };
    const totals = (earnings, deductions) => {
      const gross = round2(earnings.reduce((s, l) => s + l.amount, 0));
      return { gross, net: round2(gross - deductions.reduce((s, l) => s + l.amount, 0)) };
    };
    const periodOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const daysIn = (period) => { const [y, m] = period.split("-").map(Number); return new Date(y, m, 0).getDate(); };

    const lastMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, 1);
    const prevPeriod = periodOf(lastMonth);
    const thisPeriod = periodOf(TODAY);
    // F1.1 — holiday-aware denominators (mirror of createPayrollRun):
    // stored on the run, and the LOP line divides by them.
    const prevWorkingDays = workingDaysInPeriod(prevPeriod);
    const thisWorkingDays = workingDaysInPeriod(thisPeriod);

    // Last month: LOCKED (paid). S5 — paidDays stamped (full month: every
    // structure holder was employed the whole period).
    await db.payrollRun.create({
      data: {
        period: prevPeriod,
        status: "LOCKED",
        lockedById: hrId,
        lockedAt: addDays(TODAY, -3),
        createdById: hrId,
        workingDays: prevWorkingDays,
        payslips: {
          create: structures.map((s, i) => {
            const earnings = monthlyLines(s.components);
            const { gross, net } = totals(earnings, []);
            return {
              userId: s.user.id,
              slipNo: `PS-${prevPeriod}-${String(i + 1).padStart(3, "0")}`,
              earnings: JSON.stringify(earnings),
              deductions: "[]",
              paidDays: prevWorkingDays,
              gross,
              net,
            };
          }),
        },
      },
    });

    // This month: OPEN. F1.4 — every structure holder's LOP days are derived
    // from attendance + unpaid approved leave (mirror of
    // src/lib/lop-derivation.ts + deriveLopDaysForUsers in
    // src/server-actions/payroll.ts — "seed mirrors production math");
    // Yuki's showcase 1 day is then applied as a MANUAL override (keeping the
    // hr-holidays e2e pin: 6,700 × 1 / 21 = 319.05), and Hana's derived day
    // (her seeded ABSENT mark) rides along as lopSource AUTO. Hana also gets
    // a performance bonus line (edit-in-action showcase).
    const monthStart = new Date(Date.UTC(TODAY.getFullYear(), TODAY.getMonth(), 1));
    const monthEnd = new Date(Date.UTC(TODAY.getFullYear(), TODAY.getMonth() + 1, 0));
    const [attMarks, leaveSpans] = await Promise.all([
      db.attendanceRecord.findMany({
        where: { date: { gte: monthStart, lte: monthEnd }, status: { in: ["ABSENT", "HALF_DAY"] } },
        select: { userId: true, date: true, status: true },
      }),
      db.leaveRequest.findMany({
        where: { status: "APPROVED", startDate: { lte: monthEnd }, endDate: { gte: monthStart } },
        select: { userId: true, startDate: true, endDate: true, leaveTypeId: true },
      }),
    ]);
    const spanTypeIds = [...new Set(leaveSpans.map((r) => r.leaveTypeId))];
    const spanTypes = spanTypeIds.length > 0
      ? await db.leaveType.findMany({ where: { id: { in: spanTypeIds } }, select: { id: true, paid: true } })
      : [];
    const paidByType = new Map(spanTypes.map((t) => [t.id, t.paid]));
    // Mirror of lib/lop-derivation.ts deriveLopDays — per working day:
    // approved leave wins (paid → 0, unpaid → the working fraction), else
    // ABSENT → fraction, HALF_DAY → half of it; weekends/full holidays
    // never charge; half-day holidays count 0.5. Rounded to 2 decimals.
    const deriveLopDays = (userId, period) => {
      const [y, m] = period.split("-").map(Number);
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0));
      const markByDay = new Map(attMarks.filter((a) => a.userId === userId).map((a) => [a.date.toISOString().slice(0, 10), a.status]));
      const spans = leaveSpans
        .filter((r) => r.userId === userId)
        .map((r) => ({
          start: r.startDate, end: r.endDate,
          paid: paidByType.get(r.leaveTypeId) ?? true,
        }));
      let total = 0;
      const cursor = new Date(start);
      while (cursor <= end) {
        const dow = cursor.getUTCDay();
        if (dow !== 0 && dow !== 6) {
          const key = cursor.toISOString().slice(0, 10);
          const hol = holidayKeyMap.get(key);
          const wf = hol ? (hol.isHalfDay ? 0.5 : 0) : 1;
          if (wf > 0) {
            const span = spans.find((s) => cursor >= s.start && cursor <= s.end);
            if (span) {
              if (!span.paid) total += wf;
            } else if (markByDay.get(key) === "ABSENT") {
              total += wf;
            } else if (markByDay.get(key) === "HALF_DAY") {
              total += wf / 2;
            }
          }
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return Math.round(total * 100) / 100;
    };
    // S5 (PR-B06) — mirror of lib/working-days.ts paymentWindow + the
    // run-creation scaling: each structure holder's paid days = working days
    // in [max(month start, hireDate), min(month end, LWD)] (seed mirrors
    // production math). Soren (LWD this month) gets the clipped showcase; the
    // other holders are full-period.
    const profileByUser = new Map(
      (await db.employeeProfile.findMany({
        select: { userId: true, hireDate: true, lastWorkingDay: true },
      })).map((p) => [p.userId, p]),
    );
    const paymentDaysFor = (userId, period) => {
      const [yy, mm] = period.split("-").map(Number);
      const start = new Date(Date.UTC(yy, mm - 1, 1));
      const end = new Date(Date.UTC(yy, mm, 0));
      const p = profileByUser.get(userId);
      const from = p?.hireDate && p.hireDate > start ? p.hireDate : start;
      const until = p?.lastWorkingDay && p.lastWorkingDay < end ? p.lastWorkingDay : end;
      if (from > until) return 0;
      let count = 0;
      const cursor = new Date(from);
      while (cursor <= until) {
        const dow = cursor.getUTCDay();
        if (dow !== 0 && dow !== 6) {
          const hol = holidayKeyMap.get(cursor.toISOString().slice(0, 10));
          if (!hol) count += 1;
          else if (hol.isHalfDay) count += 0.5;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return count;
    };
    const scaleLines = (lines, paidDays, denominator) => {
      if (paidDays == null || denominator <= 0 || paidDays >= denominator) return lines;
      const fraction = paidDays / denominator;
      return lines.map((l) => ({ ...l, amount: round2(l.amount * fraction) }));
    };
    let autoLopCount = 0;
    let clippedCount = 0;
    await db.payrollRun.create({
      data: {
        period: thisPeriod,
        status: "OPEN",
        createdById: hrId,
        workingDays: thisWorkingDays,
        payslips: {
          create: structures.map((s, i) => {
            // S5 — the employment window first: lines scale to paid days.
            const paidDays = paymentDaysFor(s.user.id, thisPeriod);
            if (paidDays < thisWorkingDays) clippedCount += 1;
            let earnings = scaleLines(monthlyLines(s.components), paidDays, thisWorkingDays);
            // F1.4 derivation first …
            let lopDays = deriveLopDays(s.user.id, thisPeriod);
            let lopSource = "AUTO";
            if (lopDays > 0) autoLopCount += 1;
            // … then Yuki's showcase override (manual edit-in-action example,
            // pinned by the hr-holidays e2e).
            if (s.user.name === "Yuki Tanaka") {
              lopDays = 1;
              lopSource = "MANUAL";
            }
            if (s.user.name === "Hana Park") {
              earnings.push({ key: "bonus", label: "Q4 performance bonus", amount: 500 });
            }
            // LOP line last, from the FINAL earnings — mirrors production,
            // where updatePayslip recomputes the auto line against the
            // submitted (bonus-inclusive) gross.
            let deductions = [];
            if (lopDays > 0) {
              const grossForLop = round2(earnings.reduce((sum, l) => sum + l.amount, 0));
              const lop = round2((grossForLop * lopDays) / thisWorkingDays);
              deductions = [{ key: "lop", label: `Loss of pay (${lopDays} day${lopDays === 1 ? "" : "s"})`, amount: lop }];
            }
            const { gross, net } = totals(earnings, deductions);
            return {
              userId: s.user.id,
              slipNo: `PS-${thisPeriod}-${String(i + 1).padStart(3, "0")}`,
              earnings: JSON.stringify(earnings),
              deductions: JSON.stringify(deductions),
              lopDays,
              lopSource,
              paidDays,
              gross,
              net,
            };
          }),
        },
      },
    });
    console.log(`  ✓ Hiring R7: ${structures.length} salary structures + ${prevPeriod} run LOCKED + ${thisPeriod} run OPEN (${autoLopCount} auto-derived LOP day(s), Yuki's 1 day manual, 1 bonus line${clippedCount > 0 ? `, ${clippedCount} scaled to employment windows (S5)` : ""}) + F1.5 component catalog (7 definitions, 1 retired)`);

    // ------------------------------------------------------------------
    // P1 (F2.3) — the PayAdjustment adapter seed: one CONSUMED row whose
    // money already rides Hana's OPEN-run bonus line (the "how the Q4
    // bonus arrived" provenance), one PENDING one-shot incentive waiting
    // for next month's run, and one PENDING recurring recovery with an
    // end period — the watermark story the December run will advance.
    // ------------------------------------------------------------------
    await db.payAdjustment.deleteMany();
    const nextPeriodDate = new Date(TODAY.getFullYear(), TODAY.getMonth() + 1, 1);
    const nextPeriod = periodOf(nextPeriodDate);
    const endPeriodDate = new Date(TODAY.getFullYear(), TODAY.getMonth() + 3, 1);
    const endPeriod = periodOf(endPeriodDate);
    const openRunId = (await db.payrollRun.findFirst({ where: { period: thisPeriod }, select: { id: true } }))?.id ?? "";
    const p1Hana = structures.find((s) => s.user.name === "Hana Park")?.user.id;
    const p1Yuki = structures.find((s) => s.user.name === "Yuki Tanaka")?.user.id;
    const p1Seeded = [];
    if (p1Hana && openRunId) {
      await db.payAdjustment.create({
        data: {
          userId: p1Hana, sourceType: "INCENTIVE", sourceId: "",
          componentCode: "bonus", label: "Q4 performance bonus", side: "EARNING",
          recurrence: "ONE_SHOT", calcMode: "FIXED", amount: 500,
          period: thisPeriod, status: "CONSUMED", consumedRunId: openRunId,
          lastConsumedPeriod: thisPeriod, note: "The bonus line on Hana's open payslip",
          createdById: hrId,
        },
      });
      p1Seeded.push("Hana's consumed incentive");
    }
    if (p1Hana) {
      await db.payAdjustment.create({
        data: {
          userId: p1Hana, sourceType: "INCENTIVE", sourceId: "",
          componentCode: "", label: "Year-end spot bonus", side: "EARNING",
          recurrence: "ONE_SHOT", calcMode: "FIXED", amount: 600,
          period: nextPeriod, status: "PENDING",
          note: "Lands on the December run when it is created",
          createdById: hrId,
        },
      });
      p1Seeded.push("Hana's pending one-shot");
    }
    if (p1Yuki) {
      await db.payAdjustment.create({
        data: {
          userId: p1Yuki, sourceType: "MANUAL", sourceId: "",
          componentCode: "", label: "Equipment recovery", side: "DEDUCTION",
          recurrence: "RECURRING", calcMode: "FIXED", amount: 75,
          period: nextPeriod, endPeriod, status: "PENDING",
          note: "Three monthly instalments, then done",
          createdById: hrId,
        },
      });
      p1Seeded.push("Yuki's recurring recovery");
    }
    console.log(`  ✓ P1 (F2.3) PayAdjustment adapter: ${p1Seeded.length} rows (${p1Seeded.join(", ")}) — provenance for the seeded bonus + the queue the December run will consume`);

    // ------------------------------------------------------------------
    // P2 (LV-09, F2.2) — leave encashment seed: Annual Leave becomes
    // encashable (max 5/request, floor 5 stays), Hana has a PENDING request
    // waiting in the HR console queue, and Mira carries an APPROVED one
    // whose CONSUME ledger row + adapter row landed together (the Leave
    // view's "lands on the December run" story).
    // ------------------------------------------------------------------
    await db.leaveEncashment.deleteMany();
    const annualType = await db.leaveType.findUnique({ where: { code: "ANNUAL" }, include: { policy: true } });
    let p2Encashable = false;
    if (annualType) {
      await db.leavePolicy.upsert({
        where: { leaveTypeId: annualType.id },
        create: { leaveTypeId: annualType.id, encashable: true, maxEncashableDays: 5, nonEncashableDays: 5 },
        update: { encashable: true, maxEncashableDays: 5, nonEncashableDays: 5 },
      });
      p2Encashable = true;
    }
    const p2Hana = userByName.get("Hana Park");
    const p2Mira = userByName.get("Mira Hale");
    const p2Seeded = [];
    if (annualType && p2Hana) {
      await db.leaveEncashment.create({
        data: {
          userId: p2Hana, leaveTypeId: annualType.id, year: TODAY.getFullYear(),
          days: 3, status: "PENDING", payoutPeriod: nextPeriod,
          reason: "Offsetting a tuition payment",
          createdById: p2Hana,
        },
      });
      p2Seeded.push("Hana's pending request");
    }
    if (annualType && p2Mira) {
      const miraEnc = await db.leaveEncashment.create({
        data: {
          userId: p2Mira, leaveTypeId: annualType.id, year: TODAY.getFullYear(),
          days: 2, status: "APPROVED", payoutPeriod: nextPeriod,
          amount: 575.04, dailyRate: 287.52,
          reason: "Year-end encashment",
          createdById: p2Mira, decidedById: hrId, decidedAt: addDays(TODAY, -2),
          decisionNote: "Approved per policy.",
        },
      });
      // The approval's two transactional writes, mirrored by hand:
      // the CONSUME ledger row + the adapter row.
      await db.leaveLedgerEntry.create({
        data: {
          userId: p2Mira, leaveTypeId: annualType.id, year: TODAY.getFullYear(),
          delta: -2, entryType: "CONSUME", sourceType: "LEAVE_ENCASHMENT", sourceId: miraEnc.id,
          note: `Annual Leave encashment (2 d → ${nextPeriod})`,
          isReversal: false,
        },
      });
      await db.payAdjustment.create({
        data: {
          userId: p2Mira, sourceType: "ENCASHMENT", sourceId: miraEnc.id,
          componentCode: "", label: "Leave encashment — Annual Leave (2d)", side: "EARNING",
          recurrence: "ONE_SHOT", calcMode: "FIXED", amount: 575.04, period: nextPeriod,
          note: "2 day(s) × $287.52 (daily rate)",
          createdById: hrId,
        },
      });
      p2Seeded.push("Mira's approved request (CONSUME + adapter row)");
    }
    console.log(`  ✓ P2 (F2.2) leave encashment: Annual Leave encashable=${p2Encashable}, ${p2Seeded.length} requests (${p2Seeded.join(", ")})`);

    // ------------------------------------------------------------------
    // P5 (PR-15–18, PR-B04, F3.2) — flexible-benefits seed: Hana's
    // structure carries a $2,000 cap, her HEALTH election ($1,200/yr)
    // accrued at the October lock (mirroring the lock hook: ÷12, full
    // month), and one $60 claim paid onto November's queue — the Benefits
    // panel's live story (balance 100 − 60 = 40 still claimable).
    // ------------------------------------------------------------------
    await db.benefitElection.deleteMany();
    await db.benefitAccrual.deleteMany();
    let p5Seeded = 0;
    const p5HanaId = userByName.get("Hana Park");
    const p5PrevRun = await db.payrollRun.findFirst({ where: { period: prevPeriod }, select: { id: true, workingDays: true } });
    if (p5HanaId && p5PrevRun) {
      await db.salaryStructure.updateMany({
        where: { userId: p5HanaId, isActive: true },
        data: { maxBenefits: 2000 },
      });
      const p5Election = await db.benefitElection.create({
        data: {
          userId: p5HanaId, year: TODAY.getFullYear(),
          componentCode: "HEALTH", label: "Health insurance",
          annualAmount: 1200, status: "ACTIVE", createdById: hrId,
        },
      });
      // The October lock's accrual, mirrored by hand (1200/12 = 100).
      await db.benefitAccrual.create({
        data: {
          userId: p5HanaId, year: TODAY.getFullYear(), componentCode: "HEALTH",
          entryType: "ACCRUAL", delta: 100, sourceId: p5PrevRun.id, period: prevPeriod,
          note: "Health insurance accrual (October lock)",
        },
      });
      // A paid $60 claim (dental) onto November's adjustment queue.
      const p5ClaimAdj = await db.payAdjustment.create({
        data: {
          userId: p5HanaId, sourceType: "BENEFIT_PAYOUT", sourceId: "",
          componentCode: "HEALTH", label: "Benefit claim — Health insurance", side: "EARNING",
          recurrence: "ONE_SHOT", calcMode: "FIXED", amount: 60, period: thisPeriod,
          note: "Claim against accrued balance ($100 accrued) — dental",
          createdById: hrId,
        },
      });
      await db.benefitAccrual.create({
        data: {
          userId: p5HanaId, year: TODAY.getFullYear(), componentCode: "HEALTH",
          entryType: "CLAIM", delta: -60, sourceId: p5ClaimAdj.id, period: thisPeriod,
          note: "Benefit claim — Health insurance (dental)",
        },
      });
      p5Seeded = 2; // election + claim (accrual rides the lock hook story)
      console.log(`  ✓ P5 (F3.2) flexible benefits: Hana's HEALTH election $1,200/yr (cap $2,000), ${prevPeriod} accrual +100, one $60 claim onto ${thisPeriod} (balance $40 claimable)`);
      void p5Election;
    }

    // ------------------------------------------------------------------
    // P6 (PR-20/PR-23, PR-T01) — retention bonus seed: Diego's 3-installment
    // bonus ($1,500 → 500/month, Dec–Feb) with its outbox email — the
    // adjustment rows land on future runs' queue.
    // ------------------------------------------------------------------
    const p6Diego = userByName.get("Diego Morales");
    if (p6Diego) {
      for (let i = 0; i < 3; i++) {
        const period = i === 0 ? nextPeriod : periodOf(new Date(nextPeriodDate.getFullYear(), nextPeriodDate.getMonth() + i, 1));
        await db.payAdjustment.create({
          data: {
            userId: p6Diego, sourceType: "RETENTION_BONUS", sourceId: "",
            componentCode: "", label: "Retention bonus — Diego Morales", side: "EARNING",
            recurrence: "ONE_SHOT", calcMode: "FIXED", amount: 500, period,
            note: `Installment ${i + 1} of 3 ($1,500 total)`,
            createdById: hrId,
          },
        });
      }
      await db.mailOutbox.create({
        data: {
          kind: "RETENTION_BONUS", candidateId: null,
          toAddress: "diego@fernly.app",
          subject: "Retention bonus",
          body: `Hi Diego Morales,\n\nA retention bonus of $1,500 has been approved, paid in 3 monthly installments on the ${nextPeriod}-2027-02 payroll runs.\n\n\u2014 Fernly`,
          status: "SENT", sentById: hrId, sentAt: addDays(TODAY, -1),
          providerMessageId: "seed-retention-0000000000000000", error: "",
        },
      });
      console.log(`  ✓ P6 (PR-20/PR-23) retention bonus: Diego's $1,500 in 3 installments (${nextPeriod} onward) + the SENT notification email`);
    }

    // ------------------------------------------------------------------
    // P7 (PR-20/PR-21, F3.3) — gratuity rule seed: enabled, 3-month
    // payslip averaging, slabs 1–2 yr × 0.25 / 3–4 × 0.5 / 5+ × 1.0 months
    // of average earnings per completed year. Soren's FnF picks it up in
    // the F2.1 snapshot below (the GRATUITY line mirrors the kernel).
    // ------------------------------------------------------------------
    await db.gratuityRule.deleteMany();
    await db.gratuitySlab.deleteMany();
    await db.gratuityRule.create({ data: { enabled: true, averagingMonths: 3 } });
    await db.gratuitySlab.createMany({
      data: [
        { fromYears: 1, toYears: 2, fraction: 0.25 },
        { fromYears: 3, toYears: 4, fraction: 0.5 },
        { fromYears: 5, toYears: null, fraction: 1 },
      ],
    });
    console.log("  ✓ P7 (PR-20/PR-21) gratuity rule: enabled — slabs 1–2 yr ×0.25, 3–4 ×0.5, 5+ ×1.0 months of average earnings per completed year (3-month payslip average)");
  }

  // -------------------------------------------------------------------------
  // F2.1 — offboarding & full-and-final seed
  // (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2). Soren is the demo
  // leaver: EXITED (profile section, LWD this month), an OPEN-run payslip
  // (payroll section — the unprocessed-salary line), Annual +4 encashable
  // and Advance Annual −2 owed (leave section — the encashment + recovery
  // lines). The separation checklist is 3/5 done, the exit interview
  // COMPLETED with notes, and the FnF row sits UNSETTLED with a
  // generation-time snapshot so the demo (and the e2e) can settle it and
  // watch the payslip lock bite.
  // -------------------------------------------------------------------------
  {
    await db.exitInterview.deleteMany();
    await db.fullAndFinalStatement.deleteMany();
    const f21SorenId = userByName.get("Soren Lindqvist");
    const f21HrId = (await db.user.findUnique({ where: { email: "remy@fernly.app" }, select: { id: true } }))?.id ?? "";
    if (f21SorenId) {
      // The separation checklist — kind SEPARATION reusing the onboarding
      // machinery (EM-14). Handover/device/access are done; the interview
      // happened; settlement is the open task.
      await db.onboardingChecklist.create({
        data: {
          newHireId: f21SorenId,
          title: "Separation — Soren Lindqvist",
          kind: "SEPARATION",
          tasks: {
            create: [
              { title: "Hand over ongoing work and documents", dueOffsetDays: 3, assigneeId: f21SorenId, done: true, doneAt: addDays(TODAY, -6), doneById: f21SorenId, order: 0 },
              { title: "Return laptop and access devices", dueOffsetDays: 5, assigneeId: f21SorenId, done: true, doneAt: addDays(TODAY, -5), doneById: f21SorenId, order: 1 },
              { title: "Revoke accounts, SSO and tool access", dueOffsetDays: 5, assigneeId: mgrIngrid ?? null, done: true, doneAt: addDays(TODAY, -4), doneById: f21HrId, order: 2 },
              { title: "Hold the exit interview", dueOffsetDays: 7, assigneeId: f21HrId || null, order: 3 },
              { title: "Settle the full-and-final statement", dueOffsetDays: 10, assigneeId: f21HrId || null, order: 4 },
            ],
          },
        },
      });

      // The exit interview — COMPLETED (EM-15's full arc in one row).
      await db.exitInterview.create({
        data: {
          userId: f21SorenId,
          status: "COMPLETED",
          scheduledAt: addDays(TODAY, -3),
          interviewerId: f21HrId || null,
          notes: "Loved the release discipline; would appreciate a handover-doc template for the next QA engineer.",
          completedAt: addDays(TODAY, -3),
          createdById: f21HrId,
        },
      });

      // The UNSETTLED FnF row with the generation-time snapshot — mirrors
      // computeFullAndFinal's math (rate = monthly gross ÷ the LWD month's
      // holiday-aware working days; salary = his OPEN-run payslip net).
      const openRun = await db.payrollRun.findFirst({
        where: { status: "OPEN" },
        orderBy: { period: "desc" },
        select: { period: true },
      });
      const sorenSlip = openRun
        ? await db.payslip.findFirst({
            where: { userId: f21SorenId },
            orderBy: { createdAt: "desc" },
            select: { net: true },
          })
        : null;
      const ratePeriod = `${sorenLwd.getUTCFullYear()}-${String(sorenLwd.getUTCMonth() + 1).padStart(2, "0")}`;
      const rateDays = workingDaysInPeriod(ratePeriod);
      const dailyRate = rateDays > 0 ? Math.round((5200 / rateDays) * 100) / 100 : 0;
      const salaryNet = sorenSlip ? Math.round(sorenSlip.net * 100) / 100 : 0;
      // P7 — the GRATUITY line mirrors the kernel: completed years from the
      // seeded hire date (2025-02-03) to the LWD, × the seeded slabs, × the
      // average of the last LOCKED payslip grosses (structure gross 5,200
      // as the no-history fallback).
      const sorenHire = new Date("2025-02-03T00:00:00.000Z");
      let svcMonths = (sorenLwd.getUTCFullYear() - sorenHire.getUTCFullYear()) * 12 + (sorenLwd.getUTCMonth() - sorenHire.getUTCMonth());
      if (sorenLwd.getUTCDate() < sorenHire.getUTCDate()) svcMonths -= 1;
      if (svcMonths < 0) svcMonths = 0;
      const completedYears = Math.floor(svcMonths / 12);
      const extraMonths = svcMonths % 12;
      const sorenLockedSlip = await db.payslip.findFirst({
        where: { userId: f21SorenId, run: { status: "LOCKED" } },
        orderBy: { createdAt: "desc" },
        select: { gross: true },
      });
      const gratuityAvg = sorenLockedSlip ? Math.round(sorenLockedSlip.gross * 100) / 100 : 5200;
      const gratuitySlabs = [
        { fromYears: 1, toYears: 2, fraction: 0.25 },
        { fromYears: 3, toYears: 4, fraction: 0.5 },
        { fromYears: 5, toYears: null, fraction: 1 },
      ];
      let gratuityRaw = 0;
      for (let y = 1; y <= completedYears; y++) {
        const slab = gratuitySlabs.find((s) => y >= s.fromYears && (s.toYears === null || y <= s.toYears));
        if (slab) gratuityRaw += gratuityAvg * slab.fraction;
      }
      const gratuityAmount = Math.round(gratuityRaw * 100) / 100;
      const fnfLines = [
        { kind: "SALARY", label: `Unprocessed salary — ${openRun?.period ?? ratePeriod} run (net)`, days: null, rate: null, amount: salaryNet },
        { kind: "ENCASHMENT", label: "Annual — 4 day(s) unused", days: 4, rate: dailyRate, amount: Math.round(4 * dailyRate * 100) / 100 },
        { kind: "ADVANCE_LEAVE", label: "Advance Annual — 2 day(s) taken in advance", days: 2, rate: dailyRate, amount: -(Math.round(2 * dailyRate * 100) / 100) },
        ...(gratuityAmount > 0
          ? [{ kind: "GRATUITY", label: `Gratuity — ${completedYears} yr ${extraMonths} mo of service (slab rule)`, days: null, rate: null, amount: gratuityAmount }]
          : []),
      ];
      const payableTotal = Math.round((salaryNet + fnfLines[1].amount + gratuityAmount) * 100) / 100;
      const receivableTotal = Math.round(-fnfLines[2].amount * 100) / 100;
      await db.fullAndFinalStatement.create({
        data: {
          userId: f21SorenId,
          status: "UNSETTLED",
          lastWorkingDay: sorenLwd,
          asOf: addDays(TODAY, -1),
          lines: JSON.stringify(fnfLines),
          payableTotal,
          receivableTotal,
          netPayable: Math.round((payableTotal - receivableTotal) * 100) / 100,
          generatedById: f21HrId,
        },
      });
      console.log(`    ✓ F2.1 offboarding: Soren EXITED (LWD ${sorenLwd.toISOString().slice(0, 10)}) — separation checklist 3/5, exit interview COMPLETED, FnF UNSETTLED (payable $${payableTotal.toFixed(2)} − receivable $${receivableTotal.toFixed(2)}${gratuityAmount > 0 ? `, incl. gratuity $${gratuityAmount.toFixed(2)} (${completedYears} yr × slab rule)` : ""})`);
    }
  }

  console.log(`\n✅ Seed complete. Login: ${demoUser.email} / password from NEXT_PUBLIC_DEMO_PASSWORD (.env)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
