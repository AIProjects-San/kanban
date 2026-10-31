#!/usr/bin/env node
// L-P1-17 — Bundle budget gate. Runs after `next build`, gzip-measures each
// chunk in .next/static/chunks/, categorizes into framework/main/lazy
// buckets, and fails if any chunk exceeds its budget.
//   framework: 150KB gz   main: 200KB gz (the audit's target)   lazy: 250KB gz

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "..");
const chunksDir = join(repoRoot, ".next", "static", "chunks");

const BUDGETS = { main: 200, lazy: 250, framework: 150 };

if (!existsSync(chunksDir)) {
  console.error(`[bundle-budget] No chunks found at ${chunksDir}`);
  console.error("[bundle-budget] Run `bun run build` first.");
  process.exit(1);
}

function gzipSize(bytes) {
  return gzipSync(bytes).length;
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

let failed = false;
const results = [];

function walk(dir, depth = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, depth + 1);
    } else if (entry.name.endsWith(".js")) {
      const raw = readFileSync(fullPath);
      const gz = gzipSize(raw);
      const rel = fullPath.replace(chunksDir + "/", "");
      let category;
      let budget;
      if (/^(framework|webpack|polyfills|main)/.test(entry.name) && depth === 0) {
        category = "framework";
        budget = BUDGETS.framework;
      } else if (depth === 0 && /^app\//.test(rel)) {
        category = "main";
        budget = BUDGETS.main;
      } else {
        category = "lazy";
        budget = BUDGETS.lazy;
      }
      const passed = gz <= budget * 1024;
      if (!passed) failed = true;
      results.push({ file: rel, rawSize: raw.length, gzSize: gz, category, budget, passed });
    }
  }
}

walk(chunksDir);
results.sort((a, b) => b.gzSize - a.gzSize);

console.log("\n=== Bundle budget report (L-P1-17) ===\n");
console.log("Top 15 chunks by gzipped size:\n");
console.log("  " + "File".padEnd(50) + "Gzip".padStart(10) + "Raw".padStart(10) + "Budget".padStart(10) + "  Status");
console.log("  " + "-".repeat(95));
for (const r of results.slice(0, 15)) {
  console.log(
    "  " +
    r.file.slice(0, 50).padEnd(50) +
    formatKb(r.gzSize).padStart(10) +
    formatKb(r.rawSize).padStart(10) +
    `${r.budget}KB`.padStart(10) +
    "  " + (r.passed ? "OK" : "OVER"),
  );
}

const byCategory = {};
for (const r of results) {
  if (!byCategory[r.category]) byCategory[r.category] = { total: 0, over: 0 };
  byCategory[r.category].total += r.gzSize;
  if (!r.passed) byCategory[r.category].over++;
}
console.log("\nCategory totals (gzipped):");
for (const [cat, { total, over }] of Object.entries(byCategory)) {
  console.log(`  ${cat.padEnd(12)} ${formatKb(total).padStart(10)}  ${over > 0 ? `(${over} over budget)` : "(all within budget)"}`);
}

if (failed) {
  console.error("\n[bundle-budget] FAIL — one or more chunks exceed their budget.");
  process.exit(1);
} else {
  console.log("\n[bundle-budget] OK — all chunks within budget.");
  process.exit(0);
}
