// Link-identities backfill: populate the stable-identity columns
// (TeamMember.userId, Project.ownerUserId) for data created before the
// migration. Matches by name first (that was the old authority), then by
// email. Idempotent — safe to run repeatedly.
//
// Usage: node scripts/link-identities.js

const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();

async function main() {
  const users = await db.user.findMany({
    select: { id: true, name: true, email: true },
  });
  const byName = new Map(users.map((u) => [u.name, u]));
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  // --- TeamMember.userId ---
  const members = await db.teamMember.findMany({
    select: { id: true, name: true, email: true, userId: true },
  });
  let linkedMembers = 0;
  for (const m of members) {
    if (m.userId) continue;
    const user = byName.get(m.name) ?? byEmail.get(m.email.toLowerCase());
    if (!user) {
      console.log(`  · member "${m.name}" (${m.email}) has no matching user — skipped`);
      continue;
    }
    await db.teamMember.update({ where: { id: m.id }, data: { userId: user.id } });
    linkedMembers++;
  }
  console.log(`✓ linked ${linkedMembers}/${members.length} team members to user accounts`);

  // --- Project.ownerUserId (via the owner's member → user link) ---
  const memberByUserId = new Map(
    (await db.teamMember.findMany({ select: { id: true, userId: true } }))
      .filter((m) => m.userId)
      .map((m) => [m.userId, m.id]),
  );
  const memberByName = new Map(members.map((m) => [m.name, m]));

  const projects = await db.project.findMany({
    select: { id: true, ownerName: true, ownerUserId: true },
  });
  let linkedProjects = 0;
  for (const p of projects) {
    if (p.ownerUserId) continue;
    if (!p.ownerName) {
      console.log(`  · project "${p.id}" has no owner name — skipped`);
      continue;
    }
    // Resolve owner name → member → member.userId. If the owner has no
    // member record, fall back to a direct user-name match.
    const member = memberByName.get(p.ownerName);
    const ownerUserId = member?.userId ?? byName.get(p.ownerName)?.id ?? null;
    if (!ownerUserId) {
      console.log(`  · project "${p.ownerName}" owner unresolvable — skipped`);
      continue;
    }
    await db.project.update({ where: { id: p.id }, data: { ownerUserId } });
    linkedProjects++;
    // Sanity: owner must also map back to a member if one exists.
    if (member && !memberByUserId.get(ownerUserId)) {
      console.log(`  ! inconsistent link for project ${p.id}`);
    }
  }
  console.log(`✓ linked ${linkedProjects}/${projects.length} projects to owner user ids`);

  // --- Report ---
  const totalMembers = await db.teamMember.count();
  const unlinkedMembers = await db.teamMember.count({ where: { userId: null } });
  const totalProjects = await db.project.count();
  const unlinkedProjects = await db.project.count({ where: { ownerName: { not: "" }, ownerUserId: null } });
  console.log(
    `\nSummary: ${totalMembers - unlinkedMembers}/${totalMembers} members linked, ` +
      `${totalProjects - unlinkedProjects}/${totalProjects} named projects linked`,
  );
  if (unlinkedMembers > 0 || unlinkedProjects > 0) {
    console.log("Unlinked rows remain — they will be invisible to scoped queries until fixed.");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
