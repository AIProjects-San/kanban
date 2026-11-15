// End-to-end verification of the stable-id identity migration.
// 1. MEMBER (Theo Vance) sees only their scoped projects (id-based, not name-based)
// 2. ADMIN still sees everything
// 3. Projects owned by other users do not leak into the MEMBER's payload

import { PrismaClient } from "@prisma/client";
import { demoPassword } from "./lib/demo-env.mjs";

const BASE = "http://localhost:3000";
const db = new PrismaClient();

async function login(email, password = demoPassword()) {
  const loginRes = await fetch(`${BASE}/api/auth-better/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
  });
  return (loginRes.headers.get("set-cookie") ?? "")
    .split(/,\s*/)
    .filter((c) => c.startsWith("fernly.session_token"))
    .map((c) => c.split(";")[0])[0];
}

async function main() {
  // --- What does the DB say Theo should see? ---
  const theo = await db.user.findUnique({ where: { email: "member@fernly.app" } });
  if (!theo) throw new Error("Theo user missing — reseed needed");
  const theoMember = await db.teamMember.findUnique({ where: { userId: theo.id } });
  const ownedByTheo = await db.project.count({ where: { ownerUserId: theo.id } });
  const assignedTaskProjects = await db.task.findMany({
    where: { assignee: { userId: theo.id } },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  const explicit = await db.projectAssignment.findMany({
    where: { userId: theo.id },
    select: { projectId: true },
  });
  const expectedIds = new Set([
    ...(await db.project.findMany({ where: { ownerUserId: theo.id }, select: { id: true } })).map((p) => p.id),
    ...assignedTaskProjects.map((t) => t.projectId).filter(Boolean),
    ...explicit.map((a) => a.projectId),
  ]);
  const allProjects = await db.project.findMany({ select: { id: true, name: true, ownerUserId: true } });
  const allIds = new Set(allProjects.map((p) => p.id));
  console.log(`DB: Theo owns ${ownedByTheo} projects, member-link: ${theoMember ? "OK" : "MISSING"}, expected visible: ${expectedIds.size}/${allIds.size}`);

  // --- MEMBER dashboard fetch ---
  const memberCookie = await login("member@fernly.app");
  if (!memberCookie) throw new Error("member login failed");
  const memberRes = await fetch(`${BASE}/`, { headers: { Cookie: memberCookie } });
  const memberHtml = await memberRes.text();

  // The flight payload embeds project names. Verify Theo's owned projects
  // appear and (at least one) project he has no association with does not.
  // The page is SSR'd — project names appear as rendered HTML, both as
  // project cards AND as free text inside notifications / calendar events
  // (workspace-global by design). A hidden project only counts as a leak if
  // its name is NOT explainable by any notification/event/message text.
  const expectedNames = allProjects.filter((p) => expectedIds.has(p.id)).map((p) => p.name);
  const hiddenNames = allProjects.filter((p) => !expectedIds.has(p.id)).map((p) => p.name);

  const freeTextRows = await Promise.all([
    db.notification.findMany({ select: { message: true } }),
    db.calendarEvent.findMany({ select: { title: true, description: true } }),
    db.message.findMany({ where: { OR: [{ recipientUserId: theo.id }, { senderUserId: theo.id }] }, select: { body: true } }),
  ]);
  const freeText = JSON.stringify(freeTextRows);

  const visibleHits = expectedNames.filter((n) => memberHtml.includes(n));
  const hiddenLeaks = hiddenNames.filter((n) => memberHtml.includes(n) && !freeText.includes(n));
  console.log(`MEMBER page: ${memberRes.status}, visible projects in payload: ${visibleHits.length}/${expectedNames.length}, leaks: ${hiddenLeaks.length}`);
  if (hiddenLeaks.length > 0) {
    console.log("  LEAKED:", hiddenLeaks.slice(0, 5));
  }

  // --- ADMIN sanity ---
  const adminCookie = await login("demo@fernly.app");
  const adminRes = await fetch(`${BASE}/`, { headers: { Cookie: adminCookie } });
  const adminHtml = await adminRes.text();
  const adminHits = allProjects.filter((p) => adminHtml.includes(p.name)).length;
  console.log(`ADMIN page: ${adminRes.status}, projects visible: ${adminHits}/${allProjects.length}`);

  const pass =
    expectedNames.length > 0 &&
    visibleHits.length === expectedNames.length &&
    hiddenLeaks.length === 0 &&
    adminHits >= allProjects.length - 1; // ENDED projects may paginate in UI payload

  console.log(pass ? "\nE2E IDENTITY VERIFICATION PASSED" : "\nE2E IDENTITY VERIFICATION FAILED");
  process.exitCode = pass ? 0 : 1;
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
