// ---------------------------------------------------------------------------
// Fernly Launch-Readiness Audit — DOCX builder
// Skill compliance: R1 cover recipe (DM-1 palette), 3-section architecture
// (cover / front-matter TOC / body), TableOfContents + refresh hint +
// PageBreak, Horizontal-Only tables (percentage widths, margins, tableHeader,
// cantSplit, keepNext titles), Heading styles for TOC detection, 1.3x line
// spacing, English Profile A (Times New Roman), no TOTAL_PAGES footers.
// ---------------------------------------------------------------------------
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, PageNumber, NumberFormat, AlignmentType, HeadingLevel,
  WidthType, BorderStyle, ShadingType, SectionType, TableOfContents,
  PageBreak, TableLayoutType,
} from "docx";
import fs from "node:fs";
import { META, EXEC, SCOPE, DOMAINS_A } from "./launch-report-content-1.mjs";
import { DOMAINS_B, PART2, PLAN, GONOGO } from "./launch-report-content-2.mjs";

// ── Palette: DM-1 Deep Cyan (report/tech) — cover + table tokens ──────────
const P = {
  bg: "162235",
  titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F",
  footerColor: "687078", accent: "37DCF2",
};
const T = { headerBg: "1B6B7A", headerText: "FFFFFF", innerLine: "C8DDE2", surface: "EDF3F5" };
const INK = "000000";        // body text — pure black (Profile A formal)
const HEAD = "0A1628";       // heading color (report with cover → colored headings allowed)

const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { ...noBorders, insideHorizontal: NB, insideVertical: NB };

// ── Cover helpers (per design-system.md; Latin-aware char width) ───────────
function splitTitleLines(title, charsPerLine) {
  if (title.length <= charsPerLine) return [title];
  const breakAfter = new Set([..."，。、；：！？", ..."的与和及之在于为", ..."-_—–·/", ..." \t"]);
  const lines = [];
  let remaining = title;
  while (remaining.length > charsPerLine) {
    let breakAt = -1;
    for (let i = charsPerLine; i >= Math.floor(charsPerLine * 0.6); i--) {
      if (i < remaining.length && breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
    }
    if (breakAt === -1) {
      const limit = Math.min(remaining.length, Math.ceil(charsPerLine * 1.3));
      for (let i = charsPerLine + 1; i < limit; i++) {
        if (breakAfter.has(remaining[i - 1])) { breakAt = i; break; }
      }
    }
    if (breakAt === -1) breakAt = charsPerLine;
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  if (remaining) lines.push(remaining);
  if (lines.length > 1 && lines[lines.length - 1].length <= 2) {
    const last = lines.pop();
    lines[lines.length - 1] += last;
  }
  return lines;
}

// Latin-script title: average glyph ≈ pt × 10.5 twips (CJK pt×20 is 2× wider);
// per common-rules.md, use script-aware width estimation instead of raw char count.
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  const isLatin = !/[\u4e00-\u9fff]/.test(title);
  const charWidth = (pt) => pt * (isLatin ? 10.5 : 20);
  const charsPerLine = (pt) => Math.floor(maxWidthTwips / charWidth(pt));
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    const cpl = charsPerLine(titlePt);
    if (cpl < 2) { titlePt -= 2; continue; }
    lines = splitTitleLines(title, cpl);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) {
    lines = splitTitleLines(title, charsPerLine(minPt));
    titlePt = minPt;
  }
  return { titlePt, titleLines: lines };
}

function calcCoverSpacing(params) {
  const {
    titleLineCount = 1, titlePt = 36, hasSubtitle = false, hasEnglishLabel = false,
    metaLineCount = 0, fixedHeight = 800, pageHeight = 16838, marginTop = 0, marginBottom = 0,
  } = params;
  const SAFETY = 1200;
  const usableHeight = pageHeight - marginTop - marginBottom - SAFETY;
  const titleHeight = titleLineCount * (titlePt * 23 + 200);
  const subtitleHeight = hasSubtitle ? (12 * 23 + 600) : 0;
  const englishLabelHeight = hasEnglishLabel ? (9 * 23 + 600) : 0;
  const metaHeight = metaLineCount * (10 * 23 + 100);
  const implicitParaHeight = 3 * 300;
  const contentHeight = titleHeight + subtitleHeight + englishLabelHeight + metaHeight + fixedHeight + implicitParaHeight;
  const safeRemaining = Math.max(usableHeight - contentHeight, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}

function buildCoverR1(config) {
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 400,
  });
  const accentLeft = { style: BorderStyle.SINGLE, size: 8, color: P.accent, space: 12 };
  const children = [];
  children.push(new Paragraph({ spacing: { before: spacing.topSpacing } }));
  if (config.englishLabel) {
    children.push(new Paragraph({
      indent: { left: padL, right: padR }, spacing: { after: 500 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: P.accent, space: 8 } },
      children: [new TextRun({
        text: config.englishLabel.split("").join("  "),
        size: 18, color: P.accent, font: { ascii: "Calibri", eastAsia: "SimHei" }, characterSpacing: 40,
      })],
    }));
  }
  for (let i = 0; i < titleLines.length; i++) {
    children.push(new Paragraph({
      indent: { left: padL },
      spacing: { after: i < titleLines.length - 1 ? 100 : 300, line: Math.ceil(titlePt * 23), lineRule: "atLeast" },
      children: [new TextRun({
        text: titleLines[i], size: titleSize, bold: true,
        color: P.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" },
      })],
    }));
  }
  if (config.subtitle) {
    children.push(new Paragraph({
      indent: { left: padL }, spacing: { after: 800 },
      children: [new TextRun({
        text: config.subtitle, size: 24, color: P.subtitleColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" },
      })],
    }));
  }
  for (const line of (config.metaLines || [])) {
    children.push(new Paragraph({
      indent: { left: padL + 200 }, spacing: { after: 80 },
      border: { left: accentLeft },
      children: [new TextRun({
        text: line, size: 24, color: P.metaColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" },
      })],
    }));
  }
  children.push(new Paragraph({ spacing: { before: spacing.bottomSpacing } }));
  children.push(new Paragraph({
    indent: { left: padL, right: padR },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: P.accent, space: 8 } },
    spacing: { before: 200 },
    children: [
      new TextRun({ text: config.footerLeft || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
      new TextRun({ text: "                                        " }),
      new TextRun({ text: config.footerRight || "", size: 16, color: P.footerColor, font: { ascii: "Arial" } }),
    ],
  }));
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { type: ShadingType.CLEAR, fill: P.bg }, borders: noBorders, children,
      })],
    })],
  })];
}

// ── Body helpers ────────────────────────────────────────────────────────────
const EN = { ascii: "Times New Roman", eastAsia: "SimHei" };
const EN_BODY = { ascii: "Times New Roman", eastAsia: "SimSun" };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 32, color: HEAD, font: EN })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 28, color: HEAD, font: EN })],
  });
}
function body(text, opts = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 120, line: 312 },
    children: [new TextRun({ text, size: 24, color: INK, font: EN_BODY, bold: !!opts.bold })],
  });
}
// Lists are left-aligned (never justified) per formatting rules.
function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    alignment: AlignmentType.LEFT,
    spacing: { after: 80, line: 312 },
    children: [new TextRun({ text, size: 24, color: INK, font: EN_BODY })],
  });
}
function leadIn(text) {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 160, after: 60, line: 312 },
    children: [new TextRun({ text, bold: true, size: 24, color: HEAD, font: EN })],
  });
}
function tableTitle(text) {
  return new Paragraph({
    keepNext: true,
    spacing: { before: 160, after: 80, line: 312 },
    children: [new TextRun({ text, bold: true, size: 21, color: HEAD, font: EN })],
  });
}
function cellPara(text, { bold = false, color = INK } = {}) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { line: 312 },
    children: [new TextRun({ text: String(text), size: 21, bold, color, font: EN_BODY })],
  });
}
// Horizontal-Only business table (percentage widths only).
function makeTable({ headers, widths, rows, boldCol = null }) {
  const headerRow = new TableRow({
    tableHeader: true, cantSplit: true,
    children: headers.map((h, i) => new TableCell({
      children: [cellPara(h, { bold: true, color: T.headerText })],
      shading: { type: ShadingType.CLEAR, fill: T.headerBg },
      margins: { top: 60, bottom: 60, left: 120, right: 120 },
      width: { size: widths[i], type: WidthType.PERCENTAGE },
    })),
  });
  const dataRows = rows.map((r) => new TableRow({
    cantSplit: true,
    children: r.map((cell, i) => new TableCell({
      children: [cellPara(cell, { bold: boldCol === i })],
      margins: { top: 60, bottom: 60, left: 120, right: 120 },
      width: { size: widths[i], type: WidthType.PERCENTAGE },
    })),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: T.headerBg },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: T.headerBg },
      left: NB, right: NB,
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: "D0D0D0" },
      insideVertical: NB,
    },
    rows: [headerRow, ...dataRows],
  });
}

// ── Assemble body content ───────────────────────────────────────────────────
const bodyChildren = [];

// 1. Executive Summary
bodyChildren.push(h1("Executive Summary"));
bodyChildren.push(body(EXEC.verdictLead));
bodyChildren.push(body(EXEC.ragIntro));
bodyChildren.push(tableTitle("Table 1: Readiness by dimension (RAG)"));
bodyChildren.push(makeTable({ ...EXEC.ragTable, boldCol: 1 }));
bodyChildren.push(body(EXEC.blockersIntro, { bold: true }));
for (const b of EXEC.blockers) bodyChildren.push(body(b));

// 2. Scope & method
bodyChildren.push(h1("Scope, Sources & Method"));
bodyChildren.push(body(SCOPE.lead));
bodyChildren.push(leadIn("Method"));
for (const m of SCOPE.methodPoints) bodyChildren.push(bullet(m));
bodyChildren.push(leadIn("Out of scope"));
for (const o of SCOPE.outOfScope) bodyChildren.push(bullet(o));
bodyChildren.push(body(SCOPE.convention));

// 3. Part 1 — domains
bodyChildren.push(h1("Part 1 - Functionality Audit: Strengths, Weaknesses, Corrections"));
bodyChildren.push(body(
  "Each domain below opens with a verdict, then lists what is genuinely strong, what is weak (with file-level evidence), and the concrete correction. Domains 1.1 through 1.9 cover architecture through calendar; 1.10 through 1.18 cover analytics through documentation."
));
for (const d of [...DOMAINS_A, ...DOMAINS_B]) {
  bodyChildren.push(h2(`${d.num} ${d.title}`));
  bodyChildren.push(body(d.lead));
  bodyChildren.push(leadIn("Strengths"));
  for (const s of d.strengths) bodyChildren.push(bullet(s));
  bodyChildren.push(leadIn("Weaknesses"));
  for (const w of d.weaknesses) bodyChildren.push(bullet(w));
  bodyChildren.push(leadIn("Corrections"));
  for (const f of d.fixes) bodyChildren.push(bullet(f));
}

// 4. Part 2 — remediation
bodyChildren.push(h1("Part 2 - What Must Be Fixed Or Added Before Launch"));
bodyChildren.push(body(PART2.intro));
bodyChildren.push(h2(PART2.p0.label));
bodyChildren.push(tableTitle("Table 2: P0 launch blockers (close by day 14)"));
bodyChildren.push(makeTable(PART2.p0));
bodyChildren.push(h2(PART2.p1.label));
bodyChildren.push(tableTitle("Table 3: P1 - ship in the same window"));
bodyChildren.push(makeTable(PART2.p1));
bodyChildren.push(h2(PART2.p2.label));
bodyChildren.push(tableTitle("Table 4: P2 fast follow"));
bodyChildren.push(makeTable(PART2.p2));

// 5. 30-day plan
bodyChildren.push(h1("30-Day Execution Plan"));
bodyChildren.push(body(PLAN.lead));
bodyChildren.push(tableTitle("Table 5: Week-by-week plan"));
bodyChildren.push(makeTable(PLAN));

// 6. Go/no-go + verdict
bodyChildren.push(h1("Go/No-Go Checklist & Final Verdict"));
bodyChildren.push(body(GONOGO.intro));
bodyChildren.push(tableTitle("Table 6: Launch gates"));
bodyChildren.push(makeTable(GONOGO));
bodyChildren.push(body(GONOGO.verdict));

// ── Front matter (TOC) ──────────────────────────────────────────────────────
const frontMatter = [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 480, after: 360, line: 312 },
    children: [new TextRun({ text: "Table of Contents", bold: true, size: 32, color: HEAD, font: EN })],
  }),
  new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
  new Paragraph({
    spacing: { before: 200, line: 312 },
    children: [new TextRun({
      text: "Note: This Table of Contents is generated via field codes. To ensure page number accuracy after editing, please right-click the TOC and select \"Update Field.\"",
      italics: true, size: 18, color: "888888", font: EN_BODY,
    })],
  }),
  // No trailing PageBreak: the body section uses SectionType.NEXT_PAGE, and a
  // PageBreak at the end of this section would produce a blank page (verified
  // by postcheck; the section break alone guarantees TOC/body page separation).
];

// ── Document ────────────────────────────────────────────────────────────────
const pgSize = { width: 11906, height: 16838 };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: EN_BODY, size: 24, color: INK },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: EN, size: 32, bold: true, color: HEAD },
        paragraph: { spacing: { before: 360, after: 160, line: 312 } },
      },
      heading2: {
        run: { font: EN, size: 28, bold: true, color: HEAD },
        paragraph: { spacing: { before: 280, after: 120, line: 312 } },
      },
    },
  },
  sections: [
    { // Section 1: Cover — margin 0, no page numbers, no footer
      properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1(META),
    },
    { // Section 2: Front matter (TOC) — Roman numbering; no visible page-number
      // footer (permitted by the report scene: "TOC: optional Roman or none").
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
      },
      children: frontMatter,
    },
    { // Section 3: Body — Arabic, restart at 1; header + footer
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: META.headerText, size: 18, color: "808080", font: EN_BODY })],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080", font: EN_BODY })],
          })],
        }),
      },
      children: bodyChildren,
    },
  ],
});

const OUT = "/home/z/my-project/download/Fernly-Launch-Readiness-Audit.docx";
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log("WROTE", OUT, buf.length, "bytes");
});
