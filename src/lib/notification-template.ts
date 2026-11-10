// ---------------------------------------------------------------------------
// P24 (PL-01) — the notification template engine, pure half.
//
// The registry: every notification event whose text an admin may customize.
// Each entry carries the built-in DEFAULT templates (byte-identical to the
// pre-P24 constants the writers used to hard-code — the zero-behavior-change
// pin) plus the variable vocabulary: names, human descriptions and SAMPLE
// values. The editor renders from this registry; the writers resolve
// row→default at send time (NotificationTemplate rows hold overrides only).
//
// Substitution: {{name}} and {{ name }} (whitespace-tolerant). ONE pass —
// String.replace never re-scans its own replacements, so a variable value
// containing "{{…}}" is inert. Unknown names substitute EMPTY (the benchmark
// renders missing Jinja context the same way), which is exactly why the
// save action refuses unknown names up front: a typo must never silently
// blank a field in production mail.
//
// A "use server" file may only export async functions, so this lives in
// lib/ (the leave-email / payslip-email house pattern).
// ---------------------------------------------------------------------------

/** The placeholder grammar: {{name}} / {{ name }} — letter-led, alnum+underscore. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** Render a template with the given variables (missing → empty string). */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(PLACEHOLDER_RE, (_match: string, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

/** The placeholder names a template references, unique, in first-seen order. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Placeholder names a template uses that the event does not define. */
export function unknownPlaceholders(
  template: string,
  known: string[],
): string[] {
  return templatePlaceholders(template).filter((n) => !known.includes(n));
}

// ---------------------------------------------------------------------------
// The resolved template — the four rendered surfaces of one event. The
// in-app pair feeds Notification.title/message; the email pair feeds the
// outbox subject/body (subject stays neutral by house rule: subjects leak
// through mail-client previews, so the defaults never carry statuses or
// day counts).
// ---------------------------------------------------------------------------

export interface ResolvedNotificationTemplate {
  /** Email subject (the preview-safe line). */
  subject: string;
  /** Email plain-text body — the audit copy the Outbox re-reads. */
  body: string;
  /** In-app Notification.title. */
  title: string;
  /** In-app Notification.message. */
  message: string;
}

/** The subset of a NotificationTemplate row the resolver needs. */
export interface NotificationTemplateRowLike {
  eventKey: string;
  subjectTemplate: string;
  bodyTemplate: string;
  titleTemplate: string;
  messageTemplate: string;
}

/**
 * Resolve one event's effective templates: the workspace's override row
 * wins WHOLE (all four fields — never per-field); a missing row falls back
 * to the registry default byte-identically. `rows` may be undefined (the
 * config mock in older tests returns a config without the key) — the
 * default path is the same.
 */
export function resolveNotificationTemplate(
  rows: NotificationTemplateRowLike[] | undefined | null,
  eventKey: string,
): ResolvedNotificationTemplate {
  const row = rows?.find((r) => r.eventKey === eventKey);
  if (row) {
    return {
      subject: row.subjectTemplate,
      body: row.bodyTemplate,
      title: row.titleTemplate,
      message: row.messageTemplate,
    };
  }
  const def = getNotificationTemplateEvent(eventKey);
  return def ? def.defaults : { subject: "", body: "", title: "", message: "" };
}

// ---------------------------------------------------------------------------
// The event registry.
// ---------------------------------------------------------------------------

export interface NotificationTemplateVariable {
  /** The placeholder name as it appears in templates (without braces). */
  name: string;
  /** What the writer puts in it. */
  description: string;
  /** The preview's representative value. */
  sample: string;
}

export interface NotificationTemplateEventDef {
  eventKey: string;
  /** Editor-facing label. */
  label: string;
  /** When the event fires and who receives it. */
  description: string;
  /** The channels the event rides, human-stated. */
  channels: string;
  variables: NotificationTemplateVariable[];
  defaults: ResolvedNotificationTemplate;
}

/** The duration formatter the writers use for the {{days}} variable. */
export function formatLeaveDays(n: number): string {
  return `${n % 1 === 0 ? n : n.toFixed(1)} day${n === 1 ? "" : "s"}`;
}

const LEAVE_PENDING_VARIABLES: NotificationTemplateVariable[] = [
  { name: "requesterName", description: "The member who submitted the request.", sample: "Theo Vance" },
  { name: "typeName", description: "The leave type's name, e.g. Annual Leave.", sample: "Annual Leave" },
  { name: "startDate", description: "First day of the leave (YYYY-MM-DD).", sample: "2027-03-08" },
  { name: "endDate", description: "Last day of the leave (YYYY-MM-DD).", sample: "2027-03-09" },
  { name: "daysCount", description: "The duration as a bare number, e.g. 2 or 0.5.", sample: "2" },
  { name: "days", description: "The duration in words, e.g. “2 days” or “0.5 days”.", sample: "2 days" },
];

const LEAVE_DECIDED_VARIABLES: NotificationTemplateVariable[] = [
  ...LEAVE_PENDING_VARIABLES,
  { name: "decision", description: "approved or rejected — the past participle.", sample: "approved" },
  { name: "deciderName", description: "The manager who decided the request.", sample: "Ingrid Solberg" },
  {
    name: "noteSuffix",
    description: "The decision note in email shape — “ Note: <note>” when one was given, empty otherwise.",
    sample: " Note: Enjoy",
  },
  {
    name: "noteClose",
    description: "The decision note in in-app shape — “: <note>” when one was given, a bare “.” otherwise.",
    sample: ": Enjoy",
  },
];

// P25 (PL-02) — the engagement digest variables. `names` is pre-composed by
// the job (the birthday/anniversary list, anniversaries carrying their
// "(N years)" suffix) — the digest lists people, so the writer composes the
// list and the template places it.
const BIRTHDAY_VARIABLES: NotificationTemplateVariable[] = [
  { name: "names", description: "The employees whose birthday it is, comma-separated.", sample: "Rafael Costa, Hana Park" },
  { name: "count", description: "How many birthdays today.", sample: "2" },
  { name: "date", description: "Today's date (YYYY-MM-DD).", sample: "2026-11-10" },
];

const ANNIVERSARY_VARIABLES: NotificationTemplateVariable[] = [
  { name: "names", description: "The employees marking a work anniversary, with “(N years)” each.", sample: "Ingrid Solberg (3 years)" },
  { name: "count", description: "How many anniversaries today.", sample: "1" },
  { name: "date", description: "Today's date (YYYY-MM-DD).", sample: "2026-11-10" },
];

const HOLIDAY_VARIABLES: NotificationTemplateVariable[] = [
  { name: "holidayName", description: "The upcoming holiday's name.", sample: "Christmas Day" },
  { name: "holidayDate", description: "The holiday's date (YYYY-MM-DD).", sample: "2026-12-25" },
  { name: "daysAhead", description: "Days between today and the holiday (the workspace knob).", sample: "7" },
  { name: "date", description: "Today's date (YYYY-MM-DD).", sample: "2026-12-18" },
];

// P26 (PL-03/RJ-B18) — the interview nudge variables. Per-interview (never
// a digest): one event instance per same-day scheduled interview, received
// by its interviewer. `timeLabel` is the wall-clock the HR user picked
// (the F-R18 display truth, "HH:MM" 24-hour).
const INTERVIEW_TODAY_VARIABLES: NotificationTemplateVariable[] = [
  { name: "interviewerName", description: "The interviewer being nudged.", sample: "Ingrid Solberg" },
  { name: "candidateName", description: "The candidate the interview is with.", sample: "Rafael Costa" },
  { name: "position", description: "The candidate's position, or “Position n/a”.", sample: "Senior Frontend Engineer" },
  { name: "stageLabel", description: "The interview stage's label.", sample: "Technical screen" },
  { name: "timeLabel", description: "The picked interview time (HH:MM, 24-hour).", sample: "14:00" },
  { name: "date", description: "Today's date (YYYY-MM-DD).", sample: "2026-11-10" },
];

/**
 * The registry itself. Order is the editor's order. First consumers: the
 * leave pair (LV-T01/LV-T02 rode P21 for the opt-in email half; P24 makes
 * all four surfaces template-driven). P25/P26/P40 events (reminders,
 * scheduler nudges, the exit questionnaire) join here as their epics land.
 */
export const NOTIFICATION_TEMPLATE_EVENTS: NotificationTemplateEventDef[] = [
  {
    eventKey: "LEAVE_PENDING",
    label: "Leave request awaiting approval",
    description:
      "Fires when a member submits a leave request. The in-app notification goes to the resolved approvers unconditionally; the email rides the workspace's leave-email toggle (default off).",
    channels: "In-app (always) + email (opt-in)",
    variables: LEAVE_PENDING_VARIABLES,
    defaults: {
      subject: "Leave request awaiting your approval",
      title: "Leave request awaiting your approval",
      message:
        "{{requesterName}} requested {{daysCount}} day(s) of {{typeName}} ({{startDate}} → {{endDate}}).",
      body: [
        "A leave request from {{requesterName}} is awaiting your approval.",
        "",
        "Employee: {{requesterName}}",
        "Leave type: {{typeName}}",
        "From: {{startDate}}",
        "To: {{endDate}}",
        "Duration: {{days}}",
        "",
        "Review it in Fernly under HR → Requests.",
        "",
        "— Fernly HR",
      ].join("\n"),
    },
  },
  {
    eventKey: "LEAVE_DECIDED",
    label: "Leave request decided",
    description:
      "Fires when a manager approves or rejects a pending request. The in-app notification goes to the requester unconditionally; the email rides the workspace's leave-email toggle (default off).",
    channels: "In-app (always) + email (opt-in)",
    variables: LEAVE_DECIDED_VARIABLES,
    defaults: {
      subject: "Your leave request has been decided",
      title: "Leave request {{decision}}",
      message:
        "{{deciderName}} {{decision}} your {{daysCount}}-day {{typeName}} request{{noteClose}}",
      body: [
        "Hi {{requesterName}},",
        "",
        "Your {{days}} {{typeName}} request ({{startDate}} → {{endDate}}) has been {{decision}} by {{deciderName}}.{{noteSuffix}}",
        "",
        "The request is in Fernly under Leave.",
        "",
        "— Fernly HR",
      ].join("\n"),
    },
  },
  {
    eventKey: "EMPLOYEE_BIRTHDAY",
    label: "Birthday digest",
    description:
      "Fires daily (the scheduler's engagement pass) when one or more employees have a birthday. One workspace-wide in-app broadcast lists them; the email rides the workspace's engagement-email toggle (default off).",
    channels: "In-app broadcast (scheduler) + email (opt-in)",
    variables: BIRTHDAY_VARIABLES,
    defaults: {
      subject: "Birthdays today",
      title: "Birthdays today",
      message: "{{names}}",
      body: [
        "Birthdays today ({{date}}):",
        "",
        "{{names}}",
        "",
        "— Fernly HR",
      ].join("\n"),
    },
  },
  {
    eventKey: "EMPLOYEE_ANNIVERSARY",
    label: "Work-anniversary digest",
    description:
      "Fires daily when one or more employees mark a work anniversary (whole years since their hire date). One workspace-wide in-app broadcast lists them with their years; the email rides the workspace's engagement-email toggle (default off).",
    channels: "In-app broadcast (scheduler) + email (opt-in)",
    variables: ANNIVERSARY_VARIABLES,
    defaults: {
      subject: "Work anniversaries today",
      title: "Work anniversaries today",
      message: "{{names}}",
      body: [
        "Work anniversaries today ({{date}}):",
        "",
        "{{names}}",
        "",
        "— Fernly HR",
      ].join("\n"),
    },
  },
  {
    eventKey: "HOLIDAY_UPCOMING",
    label: "Upcoming-holiday notice",
    description:
      "Fires on the day exactly N days before each public holiday (the workspace's days-ahead knob, default 7). One workspace-wide in-app broadcast per holiday; the email rides the workspace's engagement-email toggle (default off).",
    channels: "In-app broadcast (scheduler) + email (opt-in)",
    variables: HOLIDAY_VARIABLES,
    defaults: {
      subject: "Upcoming holiday",
      title: "Upcoming holiday: {{holidayName}}",
      message: "{{holidayName}} on {{holidayDate}} — {{daysAhead}} day(s) away.",
      body: [
        "A public holiday is coming up.",
        "",
        "Holiday: {{holidayName}}",
        "Date: {{holidayDate}}",
        "Days ahead: {{daysAhead}}",
        "",
        "— Fernly HR",
      ].join("\n"),
    },
  },
  {
    eventKey: "INTERVIEW_TODAY",
    label: "Interview today (interviewer nudge)",
    description:
      "Fires daily (the scheduler's interview pass) for every interview scheduled for today. One personal in-app notification per interview to its interviewer; the email rides the workspace's interview-email toggle (default off).",
    channels: "In-app, personal (scheduler) + email (opt-in)",
    variables: INTERVIEW_TODAY_VARIABLES,
    defaults: {
      subject: "Interview today",
      title: "Interview today: {{candidateName}}",
      message: "{{stageLabel}} with {{candidateName}} at {{timeLabel}} — {{position}}.",
      body: [
        "Hi {{interviewerName}},",
        "",
        "You have an interview today at {{timeLabel}}.",
        "",
        "Candidate: {{candidateName}}",
        "Position: {{position}}",
        "Stage: {{stageLabel}}",
        "Date: {{date}}",
        "",
        "The scorecard is in Fernly under Hiring.",
        "",
        "— Fernly HR",
      ].join("\n"),
    },
  },
];

const EVENTS_BY_KEY = new Map(NOTIFICATION_TEMPLATE_EVENTS.map((e) => [e.eventKey, e]));

/** Registry lookup — null for keys the product does not (yet) define. */
export function getNotificationTemplateEvent(
  eventKey: string,
): NotificationTemplateEventDef | null {
  return EVENTS_BY_KEY.get(eventKey) ?? null;
}

/** The preview variable set for one event (samples, in declaration order). */
export function sampleTemplateVars(eventKey: string): Record<string, string> {
  const def = getNotificationTemplateEvent(eventKey);
  if (!def) return {};
  const vars: Record<string, string> = {};
  for (const v of def.variables) vars[v.name] = v.sample;
  return vars;
}

/**
 * Placeholder audit for the save action: the unknown names each field uses,
 * field by field. Pure data — the action formats the friendly refusal.
 */
export function unknownPlaceholdersByField(
  eventKey: string,
  templates: ResolvedNotificationTemplate,
): Array<{ field: "subject" | "body" | "title" | "message"; unknown: string[] }> {
  const def = getNotificationTemplateEvent(eventKey);
  const known = def ? def.variables.map((v) => v.name) : [];
  return (
    [
      ["subject", templates.subject],
      ["body", templates.body],
      ["title", templates.title],
      ["message", templates.message],
    ] as const
  ).map(([field, template]) => ({
    field,
    unknown: unknownPlaceholders(template, known),
  }));
}
