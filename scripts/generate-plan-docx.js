// Fernly Board Enhancement Plan — DOCX generator
// Follows docx skill: R1 cover (GO-1 palette), 3-section numbering, TOC,
// Profile A formal fonts (English doc -> TNR body, Calibri headings).
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  PageBreak, Header, Footer, PageNumber, NumberFormat, SectionType,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  TableOfContents, TableLayoutType,
} = require("docx");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Palette GO-1 (Graphite Orange — proposals / PRD)
// ---------------------------------------------------------------------------
const P = {
  bg: "1A2330", accent: "D4875A",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  table: { headerBg: "D4875A", headerText: "FFFFFF", accentLine: "D4875A", innerLine: "DDD0C8", surface: "F8F0EB" },
  primary: "1A2330", body: "262D38", secondary: "5B6675",
};

const noBorders = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
};
const allNoBorders = {
  top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
  left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
  insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
};

// ---------------------------------------------------------------------------
// Cover helpers (from design-system.md — width-aware for English text)
// ---------------------------------------------------------------------------
function estimateTextWidth(text, pt) {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const isCJK = (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x3000 && code <= 0x303F) || (code >= 0xFF00 && code <= 0xFFEF);
    w += isCJK ? pt * 20 : pt * 10; // latin ~half CJK width
  }
  return w;
}
function splitTitleLines(title, maxWidthTwips, pt) {
  if (estimateTextWidth(title, pt) <= maxWidthTwips) return [title];
  const words = title.split(" ");
  const lines = []; let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (estimateTextWidth(trial, pt) > maxWidthTwips && cur) { lines.push(cur); cur = word; }
    else cur = trial;
  }
  if (cur) lines.push(cur);
  // merge tiny orphan
  if (lines.length > 1 && lines[lines.length - 1].length <= 4) {
    const last = lines.pop(); lines[lines.length - 1] += " " + last;
  }
  return lines;
}
function calcTitleLayout(title, maxWidthTwips, preferredPt = 40, minPt = 24) {
  let titlePt = preferredPt, lines;
  while (titlePt >= minPt) {
    lines = splitTitleLines(title, maxWidthTwips, titlePt);
    if (lines.length <= 3) break;
    titlePt -= 2;
  }
  if (!lines || lines.length > 3) { lines = splitTitleLines(title, maxWidthTwips, minPt); titlePt = minPt; }
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
  const remainingSpace = usableHeight - contentHeight;
  const safeRemaining = Math.max(remainingSpace, 400);
  const FOOTER_MIN = 800;
  const rawTop = Math.floor(safeRemaining * 0.45);
  const rawBottom = Math.floor(safeRemaining * 0.45);
  const bottomSpacing = Math.max(rawBottom, FOOTER_MIN);
  const topSpacing = Math.max(rawTop - Math.max(0, FOOTER_MIN - rawBottom), 400);
  const midSpacing = Math.max(safeRemaining - topSpacing - bottomSpacing, 0);
  return { topSpacing, midSpacing, bottomSpacing };
}

// ---------------------------------------------------------------------------
// Cover Recipe R1 (Pure Paragraph Left) — GO-1 palette
// ---------------------------------------------------------------------------
function buildCoverR1(config) {
  const C = config.palette;
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR - 300;
  const { titlePt, titleLines } = calcTitleLayout(config.title, availableWidth, 40, 24);
  const titleSize = titlePt * 2;
  const spacing = calcCoverSpacing({
    titleLineCount: titleLines.length, titlePt,
    hasSubtitle: !!config.subtitle, hasEnglishLabel: !!config.englishLabel,
    metaLineCount: (config.metaLines || []).length, fixedHeight: 800,
    marginTop: 0, marginBottom: 0,
  });

  const children = [
    new Paragraph({ spacing: { before: spacing.topSpacing } }),
    new Paragraph({
      spacing: { after: 500 },
      children: [new TextRun({
        text: config.englishLabel.split("").join(" "),
        size: 18, color: C.accent, font: { ascii: "Calibri" }, characterSpacing: 60,
      })],
    }),
    ...titleLines.map((line, i) => new Paragraph({
      spacing: {
        after: i < titleLines.length - 1 ? 100 : 200,
        line: Math.ceil(titlePt * 23), lineRule: "atLeast",
      },
      children: [new TextRun({
        text: line, size: titleSize, bold: true,
        color: C.cover.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" },
      })],
    })),
    new Paragraph({
      spacing: { after: 100, line: Math.ceil(12 * 23), lineRule: "atLeast" },
      children: [new TextRun({
        text: config.subtitle, size: 24, color: C.cover.subtitleColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" },
      })],
    }),
    new Paragraph({ spacing: { before: spacing.midSpacing } }),
    ...(config.metaLines || []).map(line => new Paragraph({
      indent: { left: 160 }, spacing: { after: 100 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: C.accent, space: 8 } },
      children: [new TextRun({
        text: line, size: 22, color: C.cover.metaColor,
        font: { eastAsia: "Microsoft YaHei", ascii: "Arial" },
      })],
    })),
    new Paragraph({ spacing: { before: spacing.bottomSpacing } }),
    new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: C.accent, space: 10 } },
      spacing: { before: 100 },
      children: [
        new TextRun({ text: config.footerLeft || "", size: 20, color: C.cover.footerColor, font: { ascii: "Arial" } }),
        new TextRun({ text: "          " }),
        new TextRun({ text: config.footerRight || "", size: 20, color: C.cover.footerColor, font: { ascii: "Arial" } }),
      ],
    }),
  ];

  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { fill: C.bg }, borders: noBorders,
        verticalAlign: "top",
        margins: { left: padL, right: padR },
        children,
      })],
    })],
  })];
}

// ---------------------------------------------------------------------------
// Body builders (English doc: TNR body 12pt, Calibri headings, justified)
// ---------------------------------------------------------------------------
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 30, color: P.primary, font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 26, color: P.primary, font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
function body(runsOrText, opts = {}) {
  const runs = typeof runsOrText === "string"
    ? [new TextRun({ text: runsOrText, size: 24, color: P.body, font: { ascii: "Times New Roman" } })]
    : runsOrText;
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 140, line: 312 },
    ...opts,
    children: runs,
  });
}
function r(text, o = {}) {
  return new TextRun({ text, size: 24, color: P.body, font: { ascii: "Times New Roman" }, ...o });
}
function code(text) {
  return new TextRun({ text, size: 21, color: "3E4756", font: { ascii: "Courier New" } });
}
function bullet(text, opts = {}) {
  const runs = typeof text === "string" ? [r(text)] : text;
  return new Paragraph({
    bullet: { level: 0 },
    alignment: AlignmentType.LEFT,
    spacing: { after: 80, line: 312 },
    ...opts,
    children: runs,
  });
}
function tableCaption(text) {
  return new Paragraph({
    keepNext: true, alignment: AlignmentType.LEFT,
    spacing: { before: 120, after: 80 },
    children: [new TextRun({ text, bold: true, size: 21, color: P.secondary, font: { ascii: "Calibri" } })],
  });
}
function makeTable(headers, rows, widths) {
  const headerRow = new TableRow({
    tableHeader: true, cantSplit: true,
    children: headers.map((text, i) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: P.table.headerBg },
      margins: { top: 70, bottom: 70, left: 110, right: 110 },
      width: { size: widths[i], type: WidthType.PERCENTAGE },
      children: [new Paragraph({
        spacing: { line: 276 },
        children: [new TextRun({ text, bold: true, size: 20, color: P.table.headerText, font: { ascii: "Calibri" } })],
      })],
    })),
  });
  const dataRows = rows.map((row, ri) => new TableRow({
    cantSplit: true,
    children: row.map((cell, ci) => {
      const runs = Array.isArray(cell) ? cell : [new TextRun({ text: String(cell), size: 20, color: P.body, font: { ascii: "Times New Roman" } })];
      return new TableCell({
        shading: { type: ShadingType.CLEAR, fill: ri % 2 === 1 ? P.table.surface : "FFFFFF" },
        margins: { top: 60, bottom: 60, left: 110, right: 110 },
        width: { size: widths[ci], type: WidthType.PERCENTAGE },
        children: [new Paragraph({ spacing: { line: 264 }, alignment: AlignmentType.LEFT, children: runs })],
      });
    }),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: P.table.accentLine },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: P.table.accentLine },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: P.table.innerLine },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [headerRow, ...dataRows],
  });
}
function cellCode(text) { return [new TextRun({ text, size: 19, color: "3E4756", font: { ascii: "Courier New" } })]; }

// ---------------------------------------------------------------------------
// Document content
// ---------------------------------------------------------------------------
const coverConfig = {
  title: "Board Enhancement Plan",
  subtitle: "Task\u2013Bug Linking \u00b7 Required-vs-Spent Time Tracking \u00b7 Drag-and-Drop Bug Board",
  englishLabel: "IMPLEMENTATION PLAN",
  metaLines: [
    "Project: Fernly \u2014 Project Management Workspace",
    "Repository: AIProjects-San/kanban (branch: main, commit c18ca74)",
    "Scope: prisma/schema.prisma \u00b7 server actions \u00b7 board views \u00b7 seed \u00b7 tests",
    "Status: Draft for review",
    "Date: 2 November 2026",
  ],
  footerLeft: "Fernly Engineering",
  footerRight: "Confidential \u2014 Internal",
  palette: P,
};

const bodyChildren = [];

// ===== 1. Executive Summary =====
bodyChildren.push(h1("1. Executive Summary"));
bodyChildren.push(body("This plan specifies the implementation of three board enhancements requested for Fernly: linking tasks to bugs, tracking time against tasks (required versus spent), and giving the bug tracker a drag-and-drop Kanban board with the same interaction quality as the tasks board. The plan is grounded in the current codebase at commit c18ca74 and is written so that each enhancement can be shipped, tested, and reviewed independently while sharing one consolidated database migration."));
bodyChildren.push(body([
  r("The recommended approach is: "),
  r("(1)", { bold: true }),
  r(" a seven-column bug board reusing the proven dnd-kit pattern from "),
  code("src/components/views/tasks-view.tsx"),
  r(", with lifecycle-aware drop targets driven by the existing "),
  code("BUG_STATUS_TRANSITIONS"),
  r(" map; "),
  r("(2)", { bold: true }),
  r(" task-level time tracking by adding an "),
  code("estimateHours"),
  r(" field to Task and an optional "),
  code("taskId"),
  r(" foreign key to the existing TimeEntry model, so spent time is a real aggregation rather than a manually edited number; "),
  r("(3)", { bold: true }),
  r(" many-to-many task\u2013bug links through an explicit TaskBugLink join table, backfilled from the current single-column "),
  code("Bug.taskId"),
  r(" and surfaced in both the task modal and the bug detail view."),
]));
bodyChildren.push(body("Total estimated effort is 3.5 to 4 developer-days across five phases, including unit tests, component tests, and new end-to-end cucumber features. Every phase keeps the existing CI gates green: the lint and typecheck gate, the 95.4 percent coverage threshold on src/lib, the client bundle budget, the dependency audit, and the Selenium e2e suite. No change in this plan weakens an existing authorization check; all new mutations are permission-checked, session-attributed, and audit-logged, consistent with the security posture documented in docs/SECURITY.md."));

// ===== 2. Current State Assessment =====
bodyChildren.push(h1("2. Current State Assessment"));
bodyChildren.push(body("The Kanban board for tasks is mature. TasksView renders four status columns (TODO, IN_PROGRESS, IN_REVIEW, DONE) using @dnd-kit with a PointerSensor, optimistic card moves with rollback on server failure, and a refresh cycle that remounts the view with fresh server props. The moveTask server action persists status plus order. The board supports filters (all / mine / high priority / due this week) and a project picker, and cards show tag, priority, project, assignee avatar, and due date."));
bodyChildren.push(body("The bug tracker is functionally complete but board-less. The Bug model carries a full QA lifecycle (NEW, TRIAGED, IN_PROGRESS, IN_REVIEW, RESOLVED, CLOSED, REOPENED) with a validated transition map, severity and priority taxonomies, reporter and assignee users, structured reproduction fields, comments, and lifecycle timestamps. BugsView presents a paginated, filterable list with a detail modal; status changes go through changeBugStatus, which enforces the transition map, requires a resolution when moving to RESOLVED, maintains triagedAt/resolvedAt/closedAt, writes a BugComment when a comment is supplied, and logs a distinct audit action per transition. What the bug tracker lacks is an order column for within-column sorting and any drag-and-drop surface."));
bodyChildren.push(body("Time tracking exists only at the project level. TimeEntry records hours against a project and a team member with a date and description; the logTime action derives the member identity from the session (a client-supplied memberId is deliberately ignored) and validates input through logTimeSchema. Task has no estimate field, TimeEntry has no task reference, and no view aggregates time at task granularity."));
bodyChildren.push(body("Linking is a single, one-directional nullable foreign key. Bug.taskId exists in the schema and is carried in bug payloads, but the task side has no awareness of bugs, and one task can be referenced by at most one bug through that column. There is no link-management UI, no audit action for linking, and no card-level affordance on either board."));
bodyChildren.push(tableCaption("Table 1: Gap analysis by requested feature"));
bodyChildren.push(makeTable(
  ["Requested feature", "What exists today", "What is missing"],
  [
    ["Bug board with drag and drop",
      [new TextRun({ text: "7-state lifecycle + transition guard in changeBugStatus; BUG_STATUSES config with labels and accent dots; list view with filters.", size: 20, color: P.body, font: { ascii: "Times New Roman" } })],
      [new TextRun({ text: "Bug.order column; board UI with dnd-kit; moveBug action; column layout for 7 columns; drag permission gating.", size: 20, color: P.body, font: { ascii: "Times New Roman" } })]],
    ["Task time tracking (required vs spent)",
      [new TextRun({ text: "TimeEntry model + logTime action + validation + analytics charts at project/member level.", size: 20, color: P.body, font: { ascii: "Times New Roman" } })],
      [new TextRun({ text: "Task.estimateHours; TimeEntry.taskId; task-scoped actions; estimate/spent UI in task modal; time chip on cards.", size: 20, color: P.body, font: { ascii: "Times New Roman" } })]],
    ["Task\u2013bug linking",
      [new TextRun({ text: "Bug.taskId nullable FK; bug payload exposes taskId/taskName.", size: 20, color: P.body, font: { ascii: "Times New Roman" } })],
      [new TextRun({ text: "Many-to-many join table; link/unlink actions; UI sections in both modals; card badges; audit entries; backfill.", size: 20, color: P.body, font: { ascii: "Times New Roman" } })]],
  ],
  [26, 37, 37],
));
bodyChildren.push(body("Two constraints shape the whole plan. First, authorization is server-side and role-based: ADMIN and MANAGER hold bug:edit:any while MEMBER holds bug:edit:own (reporter or assignee), and any new mutation must route through the same guards rather than inventing new ones. Second, the repository CI runs against PostgreSQL with frozen lockfiles, coverage thresholds, and a bundle-budget gate, so the committed schema must remain provider postgresql even though the local sandbox preview currently runs the same schema on SQLite.", { spacing: { after: 200, line: 312 } }));

// ===== 3. Enhancement 1: Bug Board =====
bodyChildren.push(h1("3. Enhancement 1: Bug Kanban Board with Drag-and-Drop"));
bodyChildren.push(h2("3.1 Schema and action layer"));
bodyChildren.push(body([
  r("The Bug model gains an "),
  code("order Int @default(0)"),
  r(" column (indexed together with status) so cards keep a stable within-column position, exactly as Task.order does for the tasks board. A new "),
  code("moveBug(id, status, order)"),
  r(" server action wraps the existing guarded logic: it performs the same permission check as changeBugStatus (bug:edit:own or bug:edit:any via assertBugEditPermission), validates the transition against BUG_STATUS_TRANSITIONS, applies lifecycle timestamps and resolution handling, and additionally persists the new order. Internally the implementation should extract the shared transition logic so moveBug and changeBugStatus cannot drift apart; changeBugStatus simply becomes the order-preserving variant used by the detail modal."),
]));
bodyChildren.push(body("Audit behavior is preserved verbatim: a drop that resolves a bug logs bug.resolved, a drop to CLOSED logs bug.closed, a drop back to REOPENED logs bug.reopened and clears resolvedAt/closedAt, and every other transition logs bug.status_changed with from/to detail. The order-only case (dragging within the same column) writes no audit row, matching task board behavior where reordering is not an audited event."));
bodyChildren.push(h2("3.2 Board layout and interaction"));
bodyChildren.push(body([
  r("Seven columns do not fit the tasks board's four-column grid, so the bug board uses a horizontally scrollable flex container with fixed-width columns (approximately 260 px each, "),
  code("overflow-x-auto"),
  r(" on the board wrapper). Column headers reuse the BUG_STATUSES accent dots and add a live count. The drag interaction is copied from TasksView: PointerSensor with a 6 px activation constraint, DragOverlay rendering the dragged card, optimistic status/order update with rollback and an error toast when the action fails, and a router refresh on success."),
]));
bodyChildren.push(body("The lifecycle transition map creates one genuinely new interaction problem: a drop can be legal for one card and illegal for another, because the allowed targets depend on the dragged bug's current status. The design handles this in two layers. During drag, the board computes BUG_STATUS_TRANSITIONS[currentStatus] and visually dims non-targetable columns (reduced opacity, no highlight on hover), so users are guided toward legal drops. If a drop onto an illegal column still occurs, the action returns the existing AuthorizationError-style message and the board rolls the card back with the explanatory toast; the board never pre-permits an illegal transition client-side only."));
bodyChildren.push(body("Dropping a card onto the RESOLVED column requires a resolution value. To keep the drag flow fast, the board opens a compact inline dialog anchored to the drop target with the five resolution options (FIXED preselected, since it is the overwhelming default) and an optional comment box; confirming calls moveBug, and cancelling returns the card. This mirrors the semantics already implemented in changeBugStatus, where resolution defaults to FIXED only when the caller omits it \u2014 the dialog simply makes the choice explicit."));
bodyChildren.push(body("Cards are draggable only when the current user can edit that bug (bug:edit:any for ADMIN and MANAGER; bug:edit:own \u2014 reporter or assignee \u2014 for MEMBER). Read-only cards drop the drag listeners but remain clickable to open the detail modal. Card content shows severity and priority badges, title, project name when linked, assignee avatar, reporter initials, comment count, and an age indicator relative to createdAt. The existing filters (search, severity, priority) remain in a bar above the board; the status filter becomes redundant on the board and is replaced by a \u201chide CLOSED\u201d toggle that collapses the two terminal columns for focus."));
bodyChildren.push(h2("3.3 Component extraction"));
bodyChildren.push(body([
  r("Rather than duplicating roughly 200 lines of DnD wiring, the plan extracts two shared primitives from tasks-view.tsx into "),
  code("src/components/ui/board/"),
  r(": a generic BoardColumn (droppable column shell with header, count, and add-button slot) and a useBoardMove hook that encapsulates the optimistic-update-plus-rollback cycle against a generic move callback. TasksView and the new BugsView consume both with their own card renderers. This keeps the DnD correctness fixes single-sourced, which matters because the tasks board's optimistic refresh cycle was already the subject of one launch-gate fix (L-P0-1). The tasks board is refactored onto the primitives in the same phase so the e2e suite proves no regression."),
]));
bodyChildren.push(body("Board data volume is bounded: the board fetches with the same getBugsPage action, raising the page size to 200 and keeping the hasMore indicator in the header (\u201cshowing 200 of N \u2014 refine filters\u201d). Full column pagination is deliberately out of scope; the seed corpus is 7 bugs and realistic workspaces stay well under the cap.", { spacing: { after: 200, line: 312 } }));

// ===== 4. Enhancement 2: Time Tracking =====
bodyChildren.push(h1("4. Enhancement 2: Task Time Tracking (Required vs Spent)"));
bodyChildren.push(h2("4.1 Schema and aggregation"));
bodyChildren.push(body([
  r("Task gains "),
  code("estimateHours Float?"),
  r(" \u2014 nullable so legacy tasks simply have no required figure. TimeEntry gains an optional "),
  code("taskId String?"),
  r(" with a relation to Task, plus "),
  code("@@index([taskId])"),
  r(". Units stay in hours because the existing TimeEntry.hours is Float hours and the analytics view already charts that unit; introducing minutes in one place and hours in another would be a recurring source of arithmetic bugs. Spent time for a task is always an aggregation (SUM of hours over entries with that taskId), never a stored counter \u2014 this keeps history append-only and makes the entries list and the total provably consistent. Remaining time is computed client-side as estimate minus spent, rendered negative (and in the destructive color) when overrun, which is a signal, not an error state."),
]));
bodyChildren.push(h2("4.2 Actions and rules"));
bodyChildren.push(body([
  r("Two new server actions follow the established pattern (toResult wrapper, getSessionOrThrow, logAudit, revalidatePath). "),
  code("setTaskEstimate(taskId, hours)"),
  r(" requires task:edit:any, or task:edit:own when the caller is the assignee, and validates hours in the range 0.25 to 500 with a new estimate schema in validation.ts. "),
  code("logTaskTime(taskId, { hours, date, description })"),
  r(" reuses the logTimeSchema ranges for hours and description, derives the member identity from the session exactly as logTime does (the integrity rule that a client-supplied memberId is never trusted), requires the caller to be the task assignee or hold task:edit:any, and stamps the entry's projectId from the task's project so project-level analytics continue to work unchanged. Deleting an entry is permitted to its author within any timeframe and to task:edit:any holders \u2014 attribution is identity, not privilege, and the audit log records "),
  code("time.task_logged"),
  r(" and "),
  code("time.entry_deleted"),
  r(" actions with entity labels naming the task."),
]));
bodyChildren.push(h2("4.3 UI"));
bodyChildren.push(body([
  r("The task modal gains a Time section between the assignment row and the history section: an estimate input (hours, quarter-hour steps), a spent summary row with a thin progress bar (spent/estimate, full-width destructive bar when over), and the entries table (member avatar, date, hours, note, delete affordance governed by the rules above) with an inline \u201c+ Log time\u201d form. On the board card, tasks with an estimate show a compact "),
  code("3.5h / 5h"),
  r(" chip with a two-pixel progress underline; tasks with entries but no estimate show spent only. Column footers optionally aggregate total spent \u2014 deferred to a follow-up to keep the card DOM lean under the bundle budget."),
]));
bodyChildren.push(body("Member-role scoping carries over: a MEMBER sees time entries on tasks within their scoped views (own assignments and projects they belong to), which the existing dashboard scope already enforces at the query layer. Estimate is visible to all viewers of the task; entry notes follow the same visibility as the task itself.", { spacing: { after: 200, line: 312 } }));

// ===== 5. Enhancement 3: Task-Bug Linking =====
bodyChildren.push(h1("5. Enhancement 3: Task\u2013Bug Linking"));
bodyChildren.push(h2("5.1 Why many-to-many"));
bodyChildren.push(body([
  r("The current "),
  code("Bug.taskId"),
  r(" allows one bug to reference one task, and a second bug referencing the same task silently overwrites nothing but represents the relationship twice through two rows \u2014 in reality a single remediation task frequently surfaces multiple bugs and one bug can block several tasks. The plan therefore introduces an explicit join model. A single-task-to-single-bug constraint would be cheaper, but it would be a schema decision the product outgrows within weeks, and migrating later costs more than building the join table now."),
]));
bodyChildren.push(body([
  r("The new model is "),
  code("TaskBugLink"),
  r(" with "),
  code("taskId"),
  r(", "),
  code("bugId"),
  r(", "),
  code("linkedById"),
  r(", "),
  code("createdAt"),
  r(", a "),
  code("@@unique([taskId, bugId])"),
  r(" pair constraint for idempotency, cascading deletes on both sides (a hard-deleted task or bug takes its links with it), and indexes on both foreign keys. The migration backfills existing rows with "),
  code("INSERT INTO TaskBugLink (taskId, bugId, linkedById, createdAt) SELECT taskId, id, reporterUserId, createdAt FROM Bug WHERE taskId IS NOT NULL"),
  r(", then drops the Bug.taskId column in the same migration so there is exactly one source of truth. The e2e seed uses the new table from the start."),
]));
bodyChildren.push(h2("5.2 Actions, permissions, and UI"));
bodyChildren.push(body([
  r("linkTaskToBug(taskId, bugId)"),
  r(" and "),
  code("unlinkTaskBug(linkId)"),
  r(" validate both entities exist and are not soft-deleted, enforce the permission rule recommended below, upsert against the unique constraint so double-linking is a no-op rather than an error, and log "),
  code("task.bug_linked"),
  r(" / "),
  code("task.bug_unlinked"),
  r(" audit actions with both entity labels in the detail string. Cross-project links are permitted (a bug found in project A can legitimately reference a task in project B) but the link pickers surface the project of each candidate so the user is never surprised. getTask and getBug payloads are extended with lightweight link arrays (id, title, status, severity or priority) so both modals render links without extra round-trips."),
]));
bodyChildren.push(body("In the task modal, a Linked Bugs section lists each bug with severity and lifecycle badges, an unlink control, and an add-link picker (searchable by title, defaulting to open bugs of the same project, sorted by severity). The bug detail modal gains the mirror-image Linked Tasks section. On the cards, a task card with linked bugs shows a bug-count badge colored by worst open severity, and a bug card shows a linked-task chip with the task title \u2014 both click through to the respective modal. This bidirectional visibility is the actual product requirement behind \u201ctask can be linked to a bug as well\u201d: today the link exists in data but is invisible from the task side.", { spacing: { after: 200, line: 312 } }));

// ===== 6. Migration strategy =====
bodyChildren.push(h1("6. Data Migration & Schema Strategy"));
bodyChildren.push(body([
  r("All schema changes ship as one migration, "),
  code("prisma/migrations/20261103000000_board_enhancements/"),
  r(", with hand-authored up and down SQL following the repository convention (every prior migration except bug_tracking carries a down.sql). The up script creates TaskBugLink, adds Task.estimateHours, adds TimeEntry.taskId with its index and foreign key, adds Bug.order with a composite (status, order) index, backfills links from Bug.taskId, and drops Bug.taskId; the down script reverses each step, restoring Bug.taskId from the join table so no information is lost in either direction. Because the e2e CI job applies migrations with prisma migrate deploy against the PostgreSQL service container, the SQL must be valid PostgreSQL \u2014 this is the single highest-risk artifact in the plan and is called out in the risk table with its mitigation (CI is the verification stage; the migration lands on a branch and merges only after a green run)."),
]));
bodyChildren.push(body("The committed prisma/schema.prisma remains provider postgresql, matching CI, docker-compose, and the Supabase deployment documented in docs/DEPLOY.md. The local sandbox preview currently runs a SQLite override (provider switched to sqlite with DATABASE_URL=file:./dev.db); the workflow is: develop and hand-test locally against SQLite via prisma db push, then restore the postgresql provider in the commit and let CI validate the migration and the full suite. The override is a local convenience only and is never committed \u2014 the .gitignore already excludes .env, and the provider flip is a one-line diff that must not leak into the repository."));
bodyChildren.push(body("scripts/seed.js is extended in the same phase: bug rows receive order values spread within their status columns; a subset of tasks receive estimateHours (mix of unset, on-target, and overrun cases); task-scoped TimeEntry rows are generated for the existing demo members across the past 30 days; and three or four TaskBugLink rows connect seeded bugs to the tasks that plausibly fixed them, so every new surface renders meaningfully on a fresh seed. The QA corpus in download/ is unaffected.", { spacing: { after: 200, line: 312 } }));

// ===== 7. Testing =====
bodyChildren.push(h1("7. Testing & Quality Gates"));
bodyChildren.push(body([
  r("Unit tests follow the established mock-Prisma-at-the-client-boundary pattern in "),
  code("src/server-actions/__tests__/"),
  r(". New suites cover: moveBug (transition matrix \u2014 legal drop, illegal drop, resolution default and override, timestamp maintenance, order persistence, audit action selection); logTaskTime (assignee allowed, non-assignee MEMBER rejected, session-derived member identity, projectId stamping, range validation); setTaskEstimate (permission matrix, bounds); and the link actions (idempotent double-link, missing entity, cascade semantics, audit rows). The shared board hook gets focused tests for the optimistic-update, rollback, and refresh cycle \u2014 this is deliberately the most-tested new unit because the equivalent logic in TasksView was previously fixed under launch gate L-P0-1."),
]));
bodyChildren.push(body([
  r("Component tests (jsdom + Testing Library, matching the existing "),
  code("__tests__"),
  r(" colocated suites) cover the bug board rendering with seeded statuses, the resolution dialog flow, the time section of the task modal including the overrun rendering, and the link pickers. End-to-end coverage adds three cucumber features: "),
  code("bug-board.feature"),
  r(" (drag NEW to TRIAGED succeeds; drag NEW to CLOSED succeeds per the transition map; drag NEW to IN_REVIEW is rejected and the card returns; RESOLVED drop requires the dialog), "),
  code("task-time.feature"),
  r(" (log time as assignee, chip and modal totals update, estimate overrun renders), and "),
  code("task-bug-links.feature"),
  r(" (link from task side, badge appears, unlink from bug side, badge clears). The existing steps in e2e/steps already provide login, board-walk, and deletion-wait primitives to build on."),
]));
bodyChildren.push(body("Gate impact is assessed as follows. Coverage: new logic is concentrated in server actions and one hook, all unit-tested, so the 95.4 percent src/lib threshold is maintainable \u2014 the threshold file is not touched unless measured otherwise, and lowering gates to ship features is explicitly out of policy for this repository. Bundle budget: the bug board is a client component; reuse of shared primitives and the absence of new dependencies (dnd-kit is already in the initial bundle for the tasks board) keeps the delta small, and the budget script fails loudly if an initial-route chunk regresses. The audit and e2e gates run unchanged.", { spacing: { after: 200, line: 312 } }));

// ===== 8. Roadmap =====
bodyChildren.push(h1("8. Implementation Roadmap & File Change Map"));
bodyChildren.push(body("The work is sequenced so that the schema lands first (every later phase depends on it), the bug board follows (highest-visibility feature and the one that exercises the new shared primitives), then time tracking, then linking (the most cross-cutting UI), and finally the test-and-documentation hardening pass. Each phase ends with a green local run of lint, typecheck, and the unit suite, and each is a separate commit \u2014 or a separate PR if review bandwidth allows \u2014 so bisecting any later regression is trivial."));
bodyChildren.push(tableCaption("Table 2: Phases, effort, and acceptance criteria"));
bodyChildren.push(makeTable(
  ["Phase", "Scope", "Effort", "Acceptance criteria"],
  [
    ["0 \u2014 Schema & seed", "Combined migration (up/down); schema.prisma; seed.js; local db push + reseed", "0.5 d", "Fresh seed renders all new fields; migration applies on CI PostgreSQL"],
    ["1 \u2014 Bug board", "Bug.order usage; moveBug; board primitives extraction; BugsView board; resolution dialog", "1.0 d", "Drag transitions enforced; illegal drops roll back; tasks board unregressed (e2e green)"],
    ["2 \u2014 Time tracking", "estimateHours + TimeEntry.taskId actions; task-modal Time section; card chip", "0.75 d", "Assignee logs time; totals aggregate; overrun renders; project analytics unchanged"],
    ["3 \u2014 Task\u2013bug links", "TaskBugLink actions; link UI in both modals; card badges; audit entries", "0.75 d", "Link/unlink idempotent; badges bidirectional; audit rows written"],
    ["4 \u2014 Hardening", "Full unit/component/e2e suites; coverage & bundle check; docs updates", "0.5 d", "All CI gates green on the PR; docs/ARCHITECTURE and PRD updated"],
  ],
  [16, 34, 10, 40],
));
bodyChildren.push(tableCaption("Table 3: File change map"));
bodyChildren.push(makeTable(
  ["File", "Change"],
  [
    [cellCode("prisma/schema.prisma"), "Task.estimateHours; TimeEntry.taskId + index; Bug.order + composite index; TaskBugLink model"],
    [cellCode("prisma/migrations/20261103000000_board_enhancements/"), "New migration: migration.sql + down.sql (backfill + drop Bug.taskId)"],
    [cellCode("src/lib/types/index.ts"), "TaskT.estimateHours, spentHours, linkedBugs; BugListItem.order, linkedTasks; new TaskBugLinkT"],
    [cellCode("src/lib/validation.ts"), "estimateSchema, logTaskTimeSchema, taskBugLinkSchema"],
    [cellCode("src/server-actions/bugs.ts"), "moveBug; shared transition core extracted; getBug/getBugsPage include links + order"],
    [cellCode("src/server-actions/time-entries.ts"), "logTaskTime, setTaskEstimate, deleteTimeEntry"],
    [cellCode("src/server-actions/links.ts (new)"), "linkTaskToBug, unlinkTaskBug"],
    [cellCode("src/components/ui/board/ (new)"), "BoardColumn, useBoardMove shared primitives"],
    [cellCode("src/components/views/bugs-view.tsx"), "Board layout, drag wiring, resolution dialog, link section"],
    [cellCode("src/components/views/tasks-view.tsx"), "Refactor onto shared primitives; time chip; bug badge"],
    [cellCode("src/components/ui/task-modal.tsx"), "Time section; Linked Bugs section"],
    [cellCode("scripts/seed.js"), "Order values, estimates, task time entries, sample links"],
    [cellCode("e2e/features/ (3 new)"), "bug-board.feature, task-time.feature, task-bug-links.feature"],
    [cellCode("docs/ARCHITECTURE.md, docs/PRD.md"), "Data-model and capability updates"],
  ],
  [46, 54],
));
bodyChildren.push(body("Branching follows the repository's existing pattern: work lands on a feature branch (for example feat/board-enhancements) pushed to origin, CI runs the full gate matrix on the pull request, and merge to main happens only on a green run \u2014 the dependabot checkout-bump PR currently open is untouched and rebases independently.", { spacing: { after: 200, line: 312 } }));

// ===== 9. Risks & open decisions =====
bodyChildren.push(h1("9. Risks & Open Decisions"));
bodyChildren.push(tableCaption("Table 4: Risks and mitigations"));
bodyChildren.push(makeTable(
  ["Risk", "Likelihood", "Mitigation"],
  [
    ["Hand-authored PostgreSQL migration fails on CI (no local Postgres to dry-run)", "Medium", "Migration lands on a branch first; CI e2e job (prisma migrate deploy on PostgreSQL 16) is the designated verification stage; down.sql is exercised in review"],
    ["Optimistic drag updates race the server refresh (the L-P0-1 class of bug)", "Medium", "Shared useBoardMove hook concentrates the logic and carries the dedicated unit suite; rollback path tested for both boards"],
    ["Client bundle budget regression from the second board", "Low", "No new dependencies; shared primitives reduce duplication; bun run bundle:check gates every CI build"],
    ["Illegal-drop UX feels restrictive compared to the free-form tasks board", "Medium", "Legal targets are highlighted during drag and illegal columns dimmed; the error toast carries the allowed-target list from the existing guard message"],
    ["Coverage threshold pressure from new untested branches", "Low", "New logic is unit-tested in the same phase it is written; thresholds are never lowered to pass"],
  ],
  [40, 12, 48],
));
bodyChildren.push(body("Four decisions are open and are listed with the recommended default; each can be overturned at review without changing the migration, except where noted."));
bodyChildren.push(bullet([r("Link cardinality \u2014 ", { bold: true }), r("many-to-many via TaskBugLink is recommended over keeping the single foreign key. Changing this later requires a second migration; changing it now costs one line of the current one.")]));
bodyChildren.push(bullet([r("Time units \u2014 ", { bold: true }), r("hours throughout (Float), consistent with TimeEntry.hours and the analytics view. Minutes would read better on cards but introduces a second unit and conversion surface.")]));
bodyChildren.push(bullet([r("Bug list view \u2014 ", { bold: true }), r("keep it as a toggle alongside the board (the filterable table remains valuable for QA triage); default to the board. Cost is one state flag and a layout switch.")]));
bodyChildren.push(bullet([r("Who may link \u2014 ", { bold: true }), r("holders of task:edit:any or bug:edit:any may link anything; others may link only when they hold edit:own on both entities (for example the task assignee who is also the bug reporter). Unlinking follows the same rule.")]));
bodyChildren.push(body("With the defaults above, the three enhancements ship in one migration, one branch, and roughly four developer-days, with every existing gate intact and the bug tracker brought to full parity with the tasks board.", { spacing: { after: 120, line: 312 } }));

// ---------------------------------------------------------------------------
// Assemble document (3 sections: cover / front matter TOC / body)
// ---------------------------------------------------------------------------
const pgSize = { width: 11906, height: 16838 };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

function pageNumFooter() {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080", font: { ascii: "Times New Roman" } })],
    })],
  });
}
function docHeader() {
  return new Header({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: P.table.innerLine, space: 4 } },
      children: [new TextRun({ text: "Fernly Board Enhancement Plan", size: 18, color: "808080", font: { ascii: "Calibri" } })],
    })],
  });
}

const doc = new Document({
  creator: "Fernly Engineering",
  title: "Board Enhancement Plan",
  styles: {
    default: {
      document: {
        run: { font: { ascii: "Times New Roman", eastAsia: "SimSun" }, size: 24, color: P.body },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 30, bold: true, color: P.primary },
        paragraph: { spacing: { before: 400, after: 160, line: 312 }, outlineLevel: 0 },
      },
      heading2: {
        run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 26, bold: true, color: P.primary },
        paragraph: { spacing: { before: 280, after: 120, line: 312 }, outlineLevel: 1 },
      },
    },
  },
  sections: [
    // Section 1: Cover — margin 0, no footer, no pageNumbers
    {
      properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: buildCoverR1(coverConfig),
    },
    // Section 2: Front matter (TOC) — Roman numerals
    {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
      },
      footers: { default: pageNumFooter() },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 480, after: 360 },
          children: [new TextRun({ text: "Table of Contents", bold: true, size: 32, font: { ascii: "Times New Roman", eastAsia: "SimHei" }, color: P.primary })],
        }),
        new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
        new Paragraph({
          spacing: { before: 200 },
          children: [new TextRun({
            text: "Note: This Table of Contents is generated via field codes. To ensure page number accuracy after editing, please right-click the TOC and select \"Update Field.\"",
            italics: true, size: 18, color: "888888", font: { ascii: "Times New Roman" },
          })],
        }),
        // No trailing PageBreak here: the body section below uses
        // SectionType.NEXT_PAGE, which already forces the page break. A
        // PageBreak + NEXT_PAGE section break = blank page (blank-page rule ①).
      ],
    },
    // Section 3: Body — Arabic numerals starting from 1
    {
      properties: {
        type: SectionType.NEXT_PAGE,
        page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
      },
      headers: { default: docHeader() },
      footers: { default: pageNumFooter() },
      children: bodyChildren,
    },
  ],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync("/home/z/my-project/download/Fernly-Board-Enhancement-Plan.docx", buf);
  console.log("WROTE /home/z/my-project/download/Fernly-Board-Enhancement-Plan.docx", buf.length, "bytes");
});
