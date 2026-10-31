#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Launch gate 4 / W4 exit criterion — 100k-row load-test dataset generator.
//
// The k6 scenarios (scripts/load-test.k6.js) assert p95 budgets "at 100k-row
// dataset scale", but nothing could produce that dataset. This script seeds
// a realistic volume profile so the load test measures the real thing:
//
//   1,000 users (+ matching TeamMember roster rows)
//   2,000 projects
//   ~90,000 tasks (45 per project avg, mixed statuses/priorities)
//   ~40,000 time entries (last 90 days)
//   project assignments so MEMBER/MANAGER scoping has real fan-out
//
// Design notes:
//   • Deterministic data (seeded PRNG) so runs are comparable.
//   • createMany in chunks (never one giant statement); ids are precomputed
//     client-side with a cuid-shaped generator so relations can be set in
//     the same pass — no per-row round trips.
//   • Passwords hash to the SAME bcrypt string for every user (one hash,
//     computed once) — the load-test login scenario uses the shared
//     credentials printed at the end.
//   • Refuses to run unless SEED_LOAD=1 is set, prints the target database
//     host, and requires --confirm on non-localhost databases. Intended for
//     a STAGING database — never the production one.
//
// Usage:
//   SEED_LOAD=1 bash scripts/run-with-env.sh node scripts/seed-load.js            # default sizes
//   SEED_LOAD=1 LOAD_USERS=200 LOAD_PROJECTS=400 LOAD_TASKS=10000 \
//     bash scripts/run-with-env.sh node scripts/seed-load.js                      # small smoke profile
// ---------------------------------------------------------------------------

"use strict";

// --- guards (must run BEFORE any Prisma import so the .env loaded by the
// client construction can't bypass them) -----------------------------------
if (process.env.SEED_LOAD !== "1") {
  console.error(
    "\n[seed-load] Refusing to run: SEED_LOAD=1 not set.\n" +
    "This script writes tens of thousands of rows — it is meant for a STAGING\n" +
    "database used by scripts/load-test.k6.js. Set SEED_LOAD=1 explicitly:\n\n" +
    "  SEED_LOAD=1 bash scripts/run-with-env.sh node scripts/seed-load.js\n",
  );
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL ?? "";
let dbHost = "unknown";
try {
  dbHost = new URL(dbUrl).host;
} catch {
  console.error("[seed-load] DATABASE_URL is not set or not a URL — aborting.");
  process.exit(1);
}
const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(dbHost);
if (!isLocal && !process.argv.includes("--confirm")) {
  console.error(
    `\n[seed-load] Target database is ${dbHost} (not localhost).\n` +
    "Pass --confirm if you are CERTAIN this is a staging database that may be\n" +
    "filled with synthetic load-test data.\n",
  );
  process.exit(1);
}

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const db = new PrismaClient();

// --- deterministic PRNG (mulberry32) so datasets are reproducible -----------
let seedState = 0x12345678;
function rand() {
  seedState |= 0; seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// --- cuid-shaped id generator (collision-safe enough for a single run) ------
let idCounter = 0;
function genId(prefix) {
  idCounter += 1;
  const ts = Date.now().toString(36);
  const rnd = Math.floor(rand() * 1679616).toString(36).padStart(4, "0");
  return `${prefix}${ts}${idCounter.toString(36)}${rnd}lad${randInt(100, 999)}`;
}

const N_USERS = Number(process.env.LOAD_USERS ?? 1000);
const N_PROJECTS = Number(process.env.LOAD_PROJECTS ?? 2000);
const N_TASKS = Number(process.env.LOAD_TASKS ?? 90000);
const N_TIME_ENTRIES = Number(process.env.LOAD_TIME_ENTRIES ?? 40000);
const CHUNK = 2000;

const STATUSES = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"];
const PRIORITIES = ["HIGH", "MEDIUM", "LOW"];
const TAGS = ["FRONTEND", "BACKEND", "DESIGN", "QA", "MARKETING"];
const PSTATUSES = ["RUNNING", "RUNNING", "RUNNING", "PENDING", "PAUSED", "ENDED"];
const COLORS = ["forest", "ocean", "plum", "ember", "slate"];
const DEPARTMENTS = ["ENGINEERING", "DESIGN", "MARKETING", "MANAGEMENT"];

async function main() {
  const t0 = Date.now();
  console.log(`[seed-load] target=${dbHost} users=${N_USERS} projects=${N_PROJECTS} tasks=${N_TASKS} timeEntries=${N_TIME_ENTRIES}`);

  // Idempotency: remove any previous load dataset first (ordered to respect
  // FKs). Everything this script creates is identifiable by its markers
  // (loadtest.fernly.app emails, "Load ..." names), so a re-run produces a
  // clean, comparable dataset.
  console.log("[seed-load] removing any previous load dataset ...");
  await db.timeEntry.deleteMany({ where: { description: "Synthetic time entry." } });
  await db.task.deleteMany({ where: { title: { startsWith: "Load task " } } });
  await db.projectAssignment.deleteMany({ where: { project: { name: { startsWith: "Load Project " } } } });
  await db.project.deleteMany({ where: { name: { startsWith: "Load Project " } } });
  await db.teamMember.deleteMany({ where: { email: { endsWith: "@loadtest.fernly.app" } } });
  await db.user.deleteMany({ where: { email: { endsWith: "@loadtest.fernly.app" } } });

  // One bcrypt hash shared by every load user (compute once — cost 12 x 1000
  // users would take minutes individually).
  const passwordHash = bcrypt.hashSync("fernly-load-test", 12);

  // 1) Users ---------------------------------------------------------------
  const userIds = [];
  const userRows = [];
  for (let i = 0; i < N_USERS; i++) {
    const id = genId("u");
    userIds.push(id);
    userRows.push({
      id,
      email: `load-${i}@loadtest.fernly.app`,
      name: `Load User ${i}`,
      passwordHash,
      role: i === 0 ? "ADMIN" : i < 40 ? "MANAGER" : "MEMBER",
      timezone: "Pacific/Auckland",
      bio: "Synthetic load-test account.",
      avatarColor: pick(COLORS),
    });
  }
  for (let i = 0; i < userRows.length; i += CHUNK) {
    await db.user.createMany({ data: userRows.slice(i, i + CHUNK) });
  }
  console.log(`[seed-load] users: ${userRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 2) TeamMember roster rows (1:1 with users) -----------------------------
  const memberRows = userIds.map((uid, i) => ({
    id: genId("m"),
    name: `Load User ${i}`,
    role: i === 0 ? "Staff Engineer" : pick(["Engineer", "Designer", "PM"]),
    department: pick(DEPARTMENTS),
    email: `load-${i}@loadtest.fernly.app`,
    avatarColor: pick(COLORS),
    userId: uid,
  }));
  for (let i = 0; i < memberRows.length; i += CHUNK) {
    await db.teamMember.createMany({ data: memberRows.slice(i, i + CHUNK) });
  }
  const memberIds = memberRows.map((m) => m.id);
  console.log(`[seed-load] team members: ${memberRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 3) Projects (owned by the first 100 users so scoping has fan-out) ------
  const projectIds = [];
  const projectRows = [];
  for (let i = 0; i < N_PROJECTS; i++) {
    const id = genId("p");
    projectIds.push(id);
    const ownerIdx = randInt(0, Math.min(99, N_USERS - 1));
    projectRows.push({
      id,
      name: `Load Project ${i}`,
      description: "Synthetic project generated for load testing.",
      status: pick(PSTATUSES),
      priority: pick(PRIORITIES),
      dueDate: new Date(Date.now() + randInt(-30, 180) * 86400000),
      progress: randInt(0, 100),
      color: pick(COLORS),
      ownerUserId: userIds[ownerIdx],
      ownerName: `Load User ${ownerIdx}`,
    });
  }
  for (let i = 0; i < projectRows.length; i += CHUNK) {
    await db.project.createMany({ data: projectRows.slice(i, i + CHUNK) });
  }
  console.log(`[seed-load] projects: ${projectRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 4) Assignments (2-6 users per project) — capped at 60k rows -----------
  // ProjectAssignment links projects to USERS (userId), not roster rows.
  const seen = new Set();
  const assignRows = [];
  for (const pid of projectIds) {
    const n = randInt(2, 6);
    for (let j = 0; j < n; j++) {
      const uid = pick(userIds);
      const key = `${pid}:${uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      assignRows.push({ id: genId("a"), projectId: pid, userId: uid });
    }
  }
  for (let i = 0; i < assignRows.length; i += CHUNK) {
    await db.projectAssignment.createMany({ data: assignRows.slice(i, i + CHUNK) });
  }
  console.log(`[seed-load] assignments: ${assignRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 5) Tasks ----------------------------------------------------------------
  const taskRows = [];
  for (let i = 0; i < N_TASKS; i++) {
    taskRows.push({
      id: genId("t"),
      title: `Load task ${i}: ${pick(["implement", "review", "design", "test", "ship"])} ${pick(["auth", "board", "calendar", "reports", "search", "inbox"])}`,
      description: rand() < 0.3 ? "Synthetic task description with some length to it for payload realism." : "",
      status: pick(STATUSES),
      priority: pick(PRIORITIES),
      tag: pick(TAGS),
      dueDate: new Date(Date.now() + randInt(-14, 60) * 86400000),
      order: randInt(0, 999),
      projectId: pick(projectIds),
      assigneeId: rand() < 0.85 ? pick(memberIds) : null,
    });
  }
  for (let i = 0; i < taskRows.length; i += CHUNK) {
    await db.task.createMany({ data: taskRows.slice(i, i + CHUNK) });
  }
  console.log(`[seed-load] tasks: ${taskRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 6) Time entries (last 90 days) ------------------------------------------
  const teRows = [];
  for (let i = 0; i < N_TIME_ENTRIES; i++) {
    teRows.push({
      id: genId("e"),
      projectId: pick(projectIds),
      memberId: pick(memberIds),
      date: new Date(Date.now() - randInt(0, 90) * 86400000),
      hours: Math.round(rand() * 8 * 4) / 4,
      description: "Synthetic time entry.",
    });
  }
  for (let i = 0; i < teRows.length; i += CHUNK) {
    await db.timeEntry.createMany({ data: teRows.slice(i, i + CHUNK) });
  }
  console.log(`[seed-load] time entries: ${teRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const total = userRows.length + memberRows.length + projectRows.length + assignRows.length + taskRows.length + teRows.length;
  console.log(
    `\n[seed-load] DONE — ${total.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n` +
    `Load-test sign-in: load-0@loadtest.fernly.app (ADMIN) or load-5@loadtest.fernly.app (MEMBER), password: fernly-load-test\n` +
    `Next: k6 run --env BASE_URL=http://<staging-host>:3000 scripts/load-test.k6.js`,
  );
}

main()
  .catch((err) => {
    console.error("[seed-load] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
