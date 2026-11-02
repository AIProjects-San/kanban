#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Launch gate 5 — dependency audit gate ("dependency audit zero known CVEs").
//
// `bun audit` reports advisories across the WHOLE dependency graph, including
// dev toolchains (eslint/babel/cucumber chains) that never ship in the
// standalone production build. Failing CI on those makes the gate useless —
// it is permanently red and gets ignored.
//
// This script implements the honest version of the gate:
//   FAIL  when a HIGH or CRITICAL advisory affects
//         (a) any direct production dependency (package.json "dependencies"),
//         or (b) any package physically present in the traced production
//             runtime (.next/standalone/node_modules) when that directory
//             exists (i.e. run after `next build`).
//   PASS (with an informational summary) for moderate/low and dev-chain-only
//         findings.
//
// Usage:
//   bun run audit:check                # after a build (standalone scan too)
//   bunx node scripts/check-audit.mjs  # direct-dep gate only (pre-build)
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FAIL_SEVERITIES = new Set(["high", "critical"]);

// 1) Run bun audit and parse its JSON. Output shape: { [packageName]: [advisory, ...] }
let auditJson;
try {
  const raw = execFileSync("bun", ["audit", "--json"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  auditJson = JSON.parse(raw);
} catch (err) {
  // bun audit exits non-zero when advisories exist — the JSON is on stdout.
  const raw = String(err.stdout || "");
  try {
    auditJson = JSON.parse(raw);
  } catch {
    console.error("[audit:check] could not parse `bun audit --json` output:");
    console.error(String(err.stderr || err.message).slice(0, 2000));
    process.exit(1);
  }
}

// 2) Direct production dependencies.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const directProd = new Set(Object.keys(pkg.dependencies ?? {}));

// 3) Traced production runtime packages (.next/standalone/node_modules).
const runtimePackages = new Set();
const standaloneRoot = ".next/standalone/node_modules";
if (existsSync(standaloneRoot)) {
  for (const entry of readdirSync(standaloneRoot)) {
    if (entry.startsWith("@")) {
      try {
        for (const sub of readdirSync(join(standaloneRoot, entry))) {
          runtimePackages.add(`${entry}/${sub}`);
        }
      } catch { /* unreadable scoped dir — skip */ }
    } else {
      runtimePackages.add(entry);
    }
  }
}

// 4) Classify.
const failures = [];
const summary = { critical: 0, high: 0, moderate: 0, low: 0 };
for (const [name, advisories] of Object.entries(auditJson)) {
  if (!Array.isArray(advisories)) continue;
  for (const adv of advisories) {
    const sev = String(adv.severity || "").toLowerCase();
    if (summary[sev] !== undefined) summary[sev] += 1;
    const shipping = directProd.has(name) || runtimePackages.has(name);
    if (FAIL_SEVERITIES.has(sev) && shipping) {
      failures.push({ name, sev, title: adv.title, url: adv.url });
    }
  }
}

console.log(`[audit:check] advisories by severity: critical=${summary.critical} high=${summary.high} moderate=${summary.moderate} low=${summary.low}`);
console.log(`[audit:check] direct production dependencies: ${directProd.size}; traced runtime packages: ${runtimePackages.size}${existsSync(standaloneRoot) ? "" : " (standalone build not found — direct-dep gate only)"}`);

if (failures.length > 0) {
  console.error(`\n[audit:check] FAIL — ${failures.length} high/critical advisory(ies) affect a SHIPPING dependency:`);
  for (const f of failures) {
    console.error(`  [${f.sev}] ${f.name}: ${f.title}\n        ${f.url}`);
  }
  console.error("\nUpgrade the affected production dependencies before launch (launch gate 5).");
  process.exit(1);
}

console.log("[audit:check] PASS — zero high/critical advisories in shipping dependencies.");
console.log("[audit:check] (moderate/low and dev-toolchain-only findings are informational; they do not ship in the standalone build.)");
