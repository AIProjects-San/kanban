#!/usr/bin/env bun
// R-P0-3 (docs truth pass, REVIEW_TRIAGE 2026-11-16) — the docs drift
// guard. An external review was misled by README numbers that had drifted
// from the tree in BOTH directions (claims about retired mechanisms next
// to undocumented shipped modules). This gate makes that drift fail CI:
// every claimable number in README.md is recomputed from the tree and
// asserted, and the retired tokenVersion/JWT-callback prose is forbidden
// outside docs/DECISIONS.md (where it is legitimate history).
//
// Run: bun run docs:drift   (wired into the CI verify job)
//
// Adding a claimable metric to README? Add its check here in the same PR —
// a README number the guard can't see is a number that will drift.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

const failures = [];
const notes = [];

function check(label, actual, claimed) {
  if (actual !== claimed) {
    failures.push(`${label}: README says ${claimed}, tree says ${actual}`);
  } else {
    notes.push(`  ok  ${label}: ${actual}`);
  }
}

function claim(label, regex, transform = (m) => Number(m[1])) {
  const m = readme.match(regex);
  if (!m) {
    failures.push(`${label}: README no longer states this metric — restore the claim or update the guard`);
    return null;
  }
  return transform(m);
}

// --- 1. Registries (imported, not scraped — the compiler-checked source) ---
const { ACTION_META } = await import("../src/lib/audit/audit-meta.ts");
const { ALL_PERMISSIONS, ROLE_LABELS } = await import("../src/lib/auth/rbac.ts");

check("typed audit actions", Object.keys(ACTION_META).length,
  claim("typed audit actions", /\((\d+) typed actions\)/));

check("permissions in the matrix", ALL_PERMISSIONS.length,
  claim("permissions in the matrix", /(\d+)-permission matrix/));

const WORDS = { Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9, Ten: 10 };
check("roles", Object.keys(ROLE_LABELS).length,
  claim("roles", /(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\d+) roles/, (m) => WORDS[m[1]] ?? Number(m[1])));

// --- 2. Tree-scraped counts ------------------------------------------------
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const modelCount = (schema.match(/^model /gm) ?? []).length;
check("prisma models (project structure)", modelCount,
  claim("prisma models (project structure)", /schema \((\d+) models\)/));
check("prisma models (docs table)", modelCount,
  claim("prisma models (docs table)", /data model \((\d+) models\)/));

const actionDir = join(root, "src/server-actions");
const actionModules = readdirSync(actionDir)
  .filter((f) => f.endsWith(".ts") && f !== "data.ts") // data.ts is the barrel
  .length;
check("server-action modules", actionModules,
  claim("server-action modules", /one module\s+per domain, (\d+) modules\)/));

// E2E: scenarios + feature files.
const featureDir = join(root, "e2e/features");
const featureFiles = readdirSync(featureDir).filter((f) => f.endsWith(".feature"));
const scenarios = featureFiles.reduce(
  (n, f) => n + ((readFileSync(join(featureDir, f), "utf8").match(/^\s*Scenario:/gm) ?? []).length),
  0,
);
check("e2e scenarios (CI paragraph)", scenarios,
  claim("e2e scenarios (CI paragraph)", /(\d+) scenarios across (\d+) feature files/, (m) => Number(m[1])));
check("e2e feature files (CI paragraph)", featureFiles.length,
  claim("e2e feature files (CI paragraph)", /(\d+) scenarios across (\d+) feature files/, (m) => Number(m[2])));
check("e2e scenarios (testing table)", scenarios,
  claim("e2e scenarios (testing table)", /(\d+) scenarios \/ (\d+) feature files/, (m) => Number(m[1])));
check("e2e feature files (testing table)", featureFiles.length,
  claim("e2e feature files (testing table)", /(\d+) scenarios \/ (\d+) feature files/, (m) => Number(m[2])));

// Unit tests: file count + STATIC case count (it/test occurrences — the
// deterministic basis; vitest's dynamic count differs through it.each).
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), out);
    else if (/\.test\.(ts|tsx)$/.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}
const testFiles = walk(join(root, "src"), []);
const testCases = testFiles.reduce(
  (n, f) => n + ((readFileSync(f, "utf8").match(/^\s*(it|test)(\.\w+)?\(/gm) ?? []).length),
  0,
);
const NUM = (m) => Number(m[1].replace(/,/g, ""));
check("unit test cases (commands table)", testCases,
  claim("unit test cases (commands table)", /suite \(\*\*([\d,]+) test cases\*\*/, NUM));
check("unit test cases (testing table)", testCases,
  claim("unit test cases (testing table)", /\*\*([\d,]+) test cases\*\*/, NUM));
check("unit test files (testing table)", testFiles.length,
  claim("unit test files (testing table)", /jsdom \((\d+) files\)/));

// Config cache TTL — scraped from the loader (the README claims seconds).
const configLoader = readFileSync(join(root, "src/lib/infra/config-loader.ts"), "utf8");
const ttl = configLoader.match(/CACHE_TTL = (\d+)_000/);
check("config cache window (s)", ttl ? Number(ttl[1]) : null,
  claim("config cache window (s)", /within the (\d+) s config cache\s+window/));

// --- 3. Retired-mechanism prose lint ----------------------------------------
// The tokenVersion/JWT-callback claims were retired with the NextAuth v4
// stack (PR-49, ADR-011). DECISIONS.md keeps them as history; anywhere
// else they are a live lie to the next reader.
const STALE = [
  /JWT callback/i,
  /jwt callback/,
  /tokenVersion revocation/i,
  /rejects tokens whose tokenVersion/i,
  /v4 JWTs?\b[^\n]{0,80}(die|invalidat|revoke)/i,
];
const LINT_TARGETS = [
  "README.md",
  "docs/SECURITY.md",
  "docs/PRODUCTION_READINESS.md",
  "docs/ARCHITECTURE.md",
  "docs/TESTING.md",
  "prisma/schema.prisma",
];
function lintFile(rel) {
  const abs = join(root, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return; // optional target (e.g. ARCHITECTURE.md must exist, but be safe)
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const re of STALE) {
      if (re.test(line)) {
        failures.push(`${rel}:${i + 1}: retired-mechanism prose (${re}) — update to the Better Auth reality or move it to DECISIONS.md`);
      }
    }
  });
}
for (const t of LINT_TARGETS) lintFile(t);

// --- Report -----------------------------------------------------------------
console.log("docs drift guard — README claims vs tree");
for (const n of notes) console.log(n);
if (failures.length > 0) {
  console.error(`\nFAIL — ${failures.length} drift finding(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nFix the README/docs claim, or (if the tree changed on purpose) update both in one commit.");
  process.exit(1);
}
console.log("\nPASS — README's claimable numbers match the tree.");
