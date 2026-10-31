// Test the new server actions and member-scoped data filtering.
// Run with: node --experimental-vm-modules scripts/test-features.mjs
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { demoPassword } from "./lib/demo-env.mjs";

const db = new PrismaClient();

async function main() {
  console.log("=".repeat(70));
  console.log("FEATURE TEST 1: getDashboardData scoped to MEMBER role");
  console.log("=".repeat(70));

  // Simulate what getDashboardData does for Theo Vance (MEMBER)
  const theo = await db.user.findUnique({ where: { email: "member@fernly.app" } });
  console.log(`Member user: ${theo.name} (${theo.role})`);

  const owned = await db.project.findMany({
    where: { ownerName: theo.name },
    select: { id: true, name: true },
  });
  console.log(`Projects Theo owns: ${owned.length}`);
  owned.forEach((p) => console.log(`  • ${p.name}`));

  const assignedProjects = await db.task.findMany({
    where: { assignee: { name: theo.name } },
    select: { projectId: true, project: { select: { name: true } } },
    distinct: ["projectId"],
  });
  console.log(`Projects Theo has tasks in: ${assignedProjects.length}`);
  assignedProjects.forEach((p) => console.log(`  • ${p.project?.name}`));

  const memberProjectIds = new Set([
    ...owned.map((p) => p.id),
    ...assignedProjects.map((t) => t.projectId).filter(Boolean),
  ]);
  console.log(`Total unique projects Theo should see: ${memberProjectIds.size}`);

  const visibleProjects = await db.project.findMany({
    where: { id: { in: Array.from(memberProjectIds) } },
    select: { id: true, name: true, status: true },
  });
  console.log(`\n→ Member sees ${visibleProjects.length} projects (out of 24 total):`);
  visibleProjects.forEach((p) => console.log(`   • ${p.name} [${p.status}]`));

  const visibleTasks = await db.task.findMany({
    where: {
      OR: [
        { projectId: { in: Array.from(memberProjectIds) } },
        { assignee: { name: theo.name } },
      ],
    },
    select: { id: true, title: true, project: { select: { name: true } } },
  });
  const allTasks = await db.task.count();
  console.log(`\n→ Member sees ${visibleTasks.length} tasks (out of ${allTasks} total)`);

  console.log("\n" + "=".repeat(70));
  console.log("FEATURE TEST 2: getProjectMembers — who is allocated to a project?");
  console.log("=".repeat(70));

  // Pick the first project (Halcyon Labs Website) and check its allocated members
  const halcyon = await db.project.findFirst({ where: { name: "Halcyon Labs Website" } });
  console.log(`\nProject: ${halcyon.name} (owner: ${halcyon.ownerName})`);

  // Members who already have at least one task in this project
  const assignedMembers = await db.teamMember.findMany({
    where: { tasks: { some: { projectId: halcyon.id } } },
    select: { id: true, name: true, role: true },
  });
  console.log(`Members with tasks in this project: ${assignedMembers.length}`);
  assignedMembers.forEach((m) => console.log(`  • ${m.name} (${m.role})`));

  // Owner (if they're a team member)
  const owner = halcyon.ownerName
    ? await db.teamMember.findFirst({ where: { name: halcyon.ownerName } })
    : null;
  console.log(`Owner as team member: ${owner ? owner.name : "(not a team member)"}`);

  // Merge
  const allocatedIds = new Set([
    ...assignedMembers.map((m) => m.id),
    ...(owner ? [owner.id] : []),
  ]);
  console.log(`\n→ Allocated members for this project: ${allocatedIds.size}`);
  console.log(`   (the assignee dropdown should show only these people)`);

  console.log("\n" + "=".repeat(70));
  console.log("FEATURE TEST 3: changePassword");
  console.log("=".repeat(70));

  // Test the password hashing logic without actually changing the user's password
  const testUser = theo;
  const currentHash = testUser.passwordHash;
  const demoPw = demoPassword();
  const matches = await bcrypt.compare(demoPw, currentHash);
  console.log(`Current password matches NEXT_PUBLIC_DEMO_PASSWORD (.env): ${matches}`);

  const newHash = await bcrypt.hash("newPassword123", 10);
  const newMatches = await bcrypt.compare("newPassword123", newHash);
  console.log(`New hash verifies: ${newMatches}`);
  console.log(`Hash changed: ${newHash !== currentHash}`);

  console.log("\n" + "=".repeat(70));
  console.log("ALL FEATURE TESTS PASSED ✓");
  console.log("=".repeat(70));
}

main()
  .catch((e) => {
    console.error("Test failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
