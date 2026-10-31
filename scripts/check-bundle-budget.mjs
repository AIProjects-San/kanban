#!/usr/bin/env node
// L-P1-17 — Bundle budget gate. Runs after `next build`, gzip-measures each
// chunk in .next/static/chunks/, categorizes into framework/main/lazy
// buckets, and fails if any chunk exceeds its budget.
//   framework: 150KB gz   main: 200KB gz (the audit's target)   lazy: 250KB gz
//
// P1 (production-readiness re-audit) — categorization now reads
// .next/build-manifest.json to identify the root route's "main" chunks
// (`rootMainFiles` + `polyfillFiles`). The prior prefix-based heuristic
// (framework|webpack|polyfills|main) matched NONE of Turbopack's hash-only
// chunk names, so every chunk fell into "lazy" with the 250KB budget — the
// 200KB main budget was never enforced. A regression that bloated the main
// route chunk (e.g. accidentally importing Recharts into the dashboard)
// would have passed CI silently.
//
// Framework chunks are detected by content sniffing (string match on
// `react-dom`, `next/dist`, `scheduler`) — robust to filename changes.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "..");
const chunksDir = join(repoRoot, ".next", "static", "chunks");
const buildManifestPath = join(repoRoot, ".next", "build-manifest.json");

const BUDGETS = { main: 200, lazy: 250, framework: 150 };

if (!existsSync(chunksDir)) {
  console.error(`[bundle-budget] No chunks found at ${chunksDir}`);
  console.error("[bundle-budget] Run `bun run build` first.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build-manifest-driven categorization (P1 re-audit).
// ---------------------------------------------------------------------------
// `rootMainFiles` lists the chunks loaded on EVERY route (the "main" bundle).
// `polyfillFiles` are the polyfill chunks (counted as framework — they're
// shipped to every browser). Anything else is lazy-loaded.
const mainFiles = new Set();
const frameworkFiles = new Set();
if (existsSync(buildManifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(buildManifestPath, "utf8"));
    // rootMainFiles: ["static/chunks/xxx.js", ...] — strip the prefix so we
    // can match against the chunk filename.
    for (const f of manifest.rootMainFiles ?? []) {
      mainFiles.add(f.replace(/^static\/chunks\//, ""));
    }
    // polyfillFiles: same shape, treated as framework (shipped to all).
    for (const f of manifest.polyfillFiles ?? []) {
      frameworkFiles.add(f.replace(/^static\/chunks\//, ""));
    }
  } catch (err) {
    console.warn("[bundle-budget] could not parse build-manifest.json:", err.message);
  }
}

// Content markers for framework chunks (react, next, scheduler).
const FRAMEWORK_MARKERS = ["react-dom", "next/dist", "scheduler", "react.refresh", "react-reconciler"];

function gzipSize(bytes) {
  return gzipSync(bytes).length;
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

let failed = false;
const results = [];

function categorize(filename, content) {
  // Manifest-driven: explicit main or framework classification wins.
  if (mainFiles.has(filename)) return { category: "main", budget: BUDGETS.main };
  if (frameworkFiles.has(filename)) return { category: "framework", budget: BUDGETS.framework };
  // Content sniffing: detect framework chunks by their bundled code.
  // (Recharts / lodash / app code never contains these markers.)
  const sample = content.slice(0, 50_000).toString("utf8");
  if (FRAMEWORK_MARKERS.some((m) => sample.includes(m))) {
    return { category: "framework", budget: BUDGETS.framework };
  }
  // Default: lazy-loaded route chunk.
  return { category: "lazy", budget: BUDGETS.lazy };
}

function walk(dir, depth = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, depth + 1);
    } else if (entry.name.endsWith(".js")) {
      const raw = readFileSync(fullPath);
      const gz = gzipSize(raw);
      const rel = fullPath.replace(chunksDir + "/", "");
      const { category, budget } = categorize(entry.name, raw);
      const passed = gz <= budget * 1024;
      if (!passed) failed = true;
      results.push({ file: rel, rawSize: raw.length, gzSize: gz, category, budget, passed });
    }
  }
}

walk(chunksDir);
results.sort((a, b) => b.gzSize - a.gzSize);

console.log("\n=== Bundle budget report (L-P1-17) ===\n");
console.log(`Categorization: ${mainFiles.size} main (rootMainFiles), ${frameworkFiles.size} framework (polyfillFiles + content sniff), ${results.length - mainFiles.size - frameworkFiles.size} lazy\n`);
console.log("Top 15 chunks by gzipped size:\n");
console.log("  " + "File".padEnd(50) + "Gzip".padStart(10) + "Raw".padStart(10) + "Budget".padStart(10) + "  Cat".padEnd(12) + "Status");
console.log("  " + "-".repeat(105));
for (const r of results.slice(0, 15)) {
  console.log(
    "  " +
    r.file.slice(0, 50).padEnd(50) +
    formatKb(r.gzSize).padStart(10) +
    formatKb(r.rawSize).padStart(10) +
    `${r.budget}KB`.padStart(10) +
    "  " + r.category.padEnd(10) +
    (r.passed ? "OK" : "OVER"),
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
