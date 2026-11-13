#!/usr/bin/env python3
"""One-shot migration: split the lib god-files into per-domain modules.

1. src/lib/validation.ts (1,580 lines) -> src/lib/validation/{common,workspace,
   hr,leave,hiring,payroll,statutory,accounting}.ts + barrel index.ts
2. src/lib/types/index.ts (1,448 lines) -> src/lib/types/{workspace,hr,leave,
   hiring,payroll,statutory}.ts + barrel index.ts

Line ranges are extracted VERBATIM (zero logic drift); the only edits are
promoting previously-private shared primitives to `export` (cuidish, isoDate,
title, text, email, isoDateStr, refineOfferComponent, yyyymmdd) and the new
file headers/import blocks. The script asserts every original `export` line
lands in exactly one output file before writing anything.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "src" / "lib"


def read_lines(path: Path) -> list[str]:
    return path.read_text().splitlines()


# ---------------------------------------------------------------------------
# validation.ts split plan (1-indexed inclusive ranges)
# ---------------------------------------------------------------------------
VAL_RANGES: dict[str, list[tuple[int, int]]] = {
    "common": [(15, 23), (121, 121), (388, 412), (424, 430)],
    "workspace": [(25, 119), (123, 171), (173, 266), (321, 386)],
    "leave": [(268, 319), (432, 498), (1259, 1279), (1308, 1325), (1327, 1345)],
    "hr": [(500, 516), (518, 547), (549, 626), (628, 748), (750, 781), (937, 963), (965, 991)],
    "hiring": [(783, 878), (880, 922), (993, 1006), (1008, 1094)],
    "payroll": [(924, 935), (1096, 1257), (1281, 1306), (1347, 1370), (1372, 1401), (1403, 1430)],
    "statutory": [(1432, 1559)],
    "accounting": [(1561, 1580)],
}

VAL_HEADERS: dict[str, str] = {
    "common": """\
// ---------------------------------------------------------------------------
// Runtime input validation for server actions — the shared zod kit.
//
// TypeScript types vanish at runtime — every "use server" export is a public
// HTTP endpoint, so untrusted payloads must be validated before they reach
// the database. Schemas are intentionally permissive about enum VALUES
// (status strings are config-driven) but strict about shape and length.
//
// This module owns the primitives every domain schema file builds on (ids,
// dates, emails, bounded strings) and the parse/throw helpers the actions
// share. The domain schemas live beside this file; the barrel
// (lib/validation/index.ts) re-exports everything as "@/lib/validation".
// ---------------------------------------------------------------------------

import { z } from "zod";
""",
    "workspace": """\
// ---------------------------------------------------------------------------
// Workspace + bug-tracking schemas — tasks, projects, members, events,
// messages, reminders, time entries, profile/settings, workspace settings,
// config items, notification templates, and the QA bug lifecycle.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, email, isoDate, text, title } from "./common";
""",
    "leave": """\
// ---------------------------------------------------------------------------
// Leave schemas — requests/decisions, the leave-type master (policy block),
// leave periods, policy sets + assignment, balance adjustments, the balance
// report filters, encashment, and compensatory-leave claims.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, isoDateStr } from "./common";
import { PAYROLL_PERIOD_RE } from "./payroll";
""",
    "hr": """\
// ---------------------------------------------------------------------------
// HR schemas — the holiday calendar, attendance records, the employee
// directory (admin + self-service), performance reviews, the employment
// lifecycle + structured changes, onboarding checklists + template,
// offboarding/exit interviews/full-and-final, the skill master + maps, and
// employee identification documents.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, isoDateStr } from "./common";
""",
    "hiring": """\
// ---------------------------------------------------------------------------
// Recruitment schemas — stage templates, candidates, interviews, scorecards,
// joining formalities (document types, candidate documents, background
// checks) and the offer builder (templates, records, component lines).
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish, email, isoDateStr, text } from "./common";
""",
    "payroll": """\
// ---------------------------------------------------------------------------
// Payroll schemas — salary structures + the component catalog + advances,
// payroll runs/payslips, the manual PayAdjustment writer, arrears, LWP
// corrections, flexible benefits, retention bonuses, gratuity, withholding,
// and the per-run CSV exports.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { parsePayrollPeriodKey, PAYROLL_FREQUENCY_VALUES } from "@/lib/payroll/payroll-windows";
import { cuidish } from "./common";
import {
  OFFER_COMPONENT_KINDS,
  OFFER_COMPONENT_MODES,
  offerComponentSchema,
  refineOfferComponent,
} from "./hiring";
""",
    "statutory": """\
// ---------------------------------------------------------------------------
// NZ statutory engine schemas — Phase 3 (super-admin admin UI).
//
// Wire convention: every RATE on these schemas is a PERCENT number (17.5 =
// 17.5%); the actions convert to the decimal the engine and DB use. Dollar
// fields are plain annual amounts.
// (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { IR330_BASE_CODES } from "@/lib/payroll/nz/tax-codes";
import { cuidish } from "./common";
""",
    "accounting": """\
// ---------------------------------------------------------------------------
// General-ledger schemas — salary revisions (Phase 1B/G8) and journal-entry
// reversal (Phase 1C/G2). (Split from the former lib/validation.ts god-file.)
// ---------------------------------------------------------------------------

import { z } from "zod";

import { cuidish } from "./common";
import { yyyymmdd } from "./statutory";
""",
}

VAL_BARREL = """\
// ---------------------------------------------------------------------------
// Runtime input validation for server actions — barrel.
//
// The schemas live in per-domain files beside this index (common / workspace
// / hr / leave / hiring / payroll / statutory / accounting), split from the
// former 1,580-line lib/validation.ts god-file. "@/lib/validation" keeps
// resolving here, so existing importers are unchanged; new schemas go in
// their domain file.
// ---------------------------------------------------------------------------

export * from "./common";
export * from "./workspace";
export * from "./hr";
export * from "./leave";
export * from "./hiring";
export * from "./payroll";
export * from "./statutory";
export * from "./accounting";
"""

# Previously-private declarations promoted to exported (exact line-prefix match).
VAL_PROMOTE = {
    "common": [
        "const cuidish =",
        "const isoDate =",
        "const title =",
        "const text =",
        "const email =",
        "const isoDateStr =",
    ],
    "hiring": ["function refineOfferComponent("],
    "statutory": ["const yyyymmdd ="],
}

# ---------------------------------------------------------------------------
# types/index.ts split plan
# ---------------------------------------------------------------------------
TYP_RANGES: dict[str, list[tuple[int, int]]] = {
    "payroll": [(5, 6), (723, 741), (884, 994), (1101, 1150), (1152, 1354), (1410, 1448)],
    "leave": [(34, 47), (97, 197), (458, 467), (1356, 1380)],
    "hr": [(49, 95), (199, 414), (416, 456), (743, 792), (1392, 1408)],
    "workspace": [(8, 32), (469, 632)],
    "hiring": [(634, 721), (794, 882), (1382, 1390)],
    "statutory": [(996, 1099)],
}

TYP_HEADERS: dict[str, str] = {
    "workspace": """\
// Workspace types — the board (projects, tasks, members, events, messages,
// notifications, reminders, time entries), the dashboard payload, and the QA
// bug lifecycle. Client-safe mirrors of the Prisma models.
// (Split from the former lib/types/index.ts god-file.)
""",
    "hr": """\
// HR module types — attendance, the employee directory, performance reviews,
// the employment lifecycle + property history, onboarding (checklists + the
// configurable template), offboarding/exit interviews/full-and-final, the
// skill master + maps, and employee identification documents.
// (Split from the former lib/types/index.ts god-file.)
""",
    "leave": """\
// Leave types — statuses, the holiday-calendar entry, the leave-type master
// (allocation strategy vocabulary), requests, compensatory claims, balances,
// and encashment. Client-safe mirrors of the Prisma models.
// (Split from the former lib/types/index.ts god-file.)
""",
    "hiring": """\
// Recruitment module types (docs/RECRUITMENT_MODULE_PLAN.md) — stage
// configs, candidates + stages, the mail outbox, document types, candidate
// documents, background checks, offers + templates, and funnel analytics.
// (Split from the former lib/types/index.ts god-file.)
""",
    "payroll": """\
// Payroll types — salary structures/components/assignments/advances, payroll
// runs + payslips (LOP details, per-component YTD, the statutory snapshot),
// pay adjustments, benefits, LWP corrections, arrears, gratuity, and
// withholding. Client-safe mirrors of the Prisma models.
// (Split from the former lib/types/index.ts god-file.)
"""

    ,
    "statutory": """\
// NZ statutory engine — Phase 3 (super-admin admin UI) client types.
// (Split from the former lib/types/index.ts god-file.)
""",
}

# Extra import blocks appended to a type file's header.
TYP_IMPORTS: dict[str, str] = {
    "payroll": """
import type { PayrollFrequency } from "@/lib/payroll/payroll-windows";
import type { OfferComponentT } from "./hiring";
""",
}

TYP_BARREL = """\
// Shared Fernly types — mirror Prisma models but client-safe.
//
// Barrel only: the definitions live in per-domain files beside this index
// (workspace / hr / leave / hiring / payroll / statutory), split from the
// former 1,448-line god-file. "@/lib/types" keeps resolving here, so
// existing importers are unchanged; new types go in their domain file.

export * from "./workspace";
export * from "./hr";
export * from "./leave";
export * from "./hiring";
export * from "./payroll";
export * from "./statutory";
"""


def slice_ranges(lines: list[str], ranges: list[tuple[int, int]]) -> str:
    out: list[str] = []
    for start, end in ranges:
        out.extend(lines[start - 1 : end])
        out.append("")  # blank separator between moved sections
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out) + "\n"


def assert_full_coverage(lines: list[str], ranges: dict[str, list[tuple[int, int]]], src: str) -> None:
    """Every top-level `export` line of the original must land in exactly one range."""
    export_lines = [
        i + 1
        for i, ln in enumerate(lines)
        if re.match(r"^export\s+(const|function|type|interface|class|enum)\s", ln)
    ]
    covered: dict[int, str] = {}
    for name, rngs in ranges.items():
        for start, end in rngs:
            for n in export_lines:
                if start <= n <= end:
                    if n in covered:
                        sys.exit(f"OVERLAP: line {n} of {src} claimed by {covered[n]} and {name}")
                    covered[n] = name
    missing = [n for n in export_lines if n not in covered]
    if missing:
        sys.exit(f"MISSING export lines in {src} split: {missing}")
    print(f"  {src}: {len(export_lines)} exports -> {sorted(set(covered.values()))}")


def promote(chunk: str, decls: list[str], fname: str) -> str:
    for decl in decls:
        old, new = f"\n{decl}", f"\nexport {decl}"
        if chunk.startswith(decl):
            chunk = "export " + chunk
        elif old in chunk:
            chunk = chunk.replace(old, new, 1)
        else:
            sys.exit(f"PROMOTE FAILED: {decl!r} not found in chunk for {fname}")
    return chunk


def build(
    src_path: Path,
    out_dir: Path,
    ranges: dict[str, list[tuple[int, int]]],
    headers: dict[str, str],
    imports: dict[str, str],
    promotions: dict[str, list[str]],
    barrel: str,
) -> None:
    lines = read_lines(src_path)
    assert_full_coverage(lines, ranges, src_path.name)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, rngs in ranges.items():
        chunk = slice_ranges(lines, rngs)
        if name in promotions:
            chunk = promote(chunk, promotions[name], name)
        body = headers[name] + imports.get(name, "\n") + "\n" + chunk
        (out_dir / f"{name}.ts").write_text(body)
        n = len(body.splitlines())
        print(f"  wrote {out_dir.name}/{name}.ts ({n} lines)")
    (out_dir / "index.ts").write_text(barrel)
    print(f"  wrote {out_dir.name}/index.ts (barrel)")


def main() -> None:
    print("splitting src/lib/validation.ts:")
    build(
        LIB / "validation.ts",
        LIB / "validation",
        VAL_RANGES,
        VAL_HEADERS,
        {},
        VAL_PROMOTE,
        VAL_BARREL,
    )
    print("splitting src/lib/types/index.ts:")
    build(
        LIB / "types" / "index.ts",
        LIB / "types",
        TYP_RANGES,
        TYP_HEADERS,
        TYP_IMPORTS,
        {},
        TYP_BARREL,
    )
    print("OK")


if __name__ == "__main__":
    main()
