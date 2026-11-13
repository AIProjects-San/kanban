import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// P24 (PL-01) — the notification template kernel. Two jobs:
//   1. the substitution grammar (render / placeholders / unknown audit);
//   2. the ZERO-BEHAVIOR-CHANGE pin — the registry defaults render exactly
//      the strings the leave writers hard-coded pre-P24 (the leave-email
//      builders + the in-app literals), so an unmigrated database (no
//      NotificationTemplate rows) keeps byte-identical notifications.
// ---------------------------------------------------------------------------

import {
  renderTemplate,
  templatePlaceholders,
  unknownPlaceholders,
  resolveNotificationTemplate,
  unknownPlaceholdersByField,
  getNotificationTemplateEvent,
  sampleTemplateVars,
  formatLeaveDays,
  NOTIFICATION_TEMPLATE_EVENTS,
} from "@/lib/email/notification-template";
import {
  leavePendingEmailSubject,
  leavePendingEmailText,
  leaveDecidedEmailSubject,
  leaveDecidedEmailText,
} from "@/lib/leave/leave-email";

describe("P24 — renderTemplate (the substitution grammar)", () => {
  it("substitutes known names", () => {
    expect(renderTemplate("Hi {{name}}, {{kind}}!", { name: "Theo", kind: "hi" })).toBe("Hi Theo, hi!");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{ name }}!", { name: "Theo" })).toBe("Hi Theo!");
    expect(renderTemplate("Hi {{\nname\n}}!", { name: "Theo" })).toBe("Hi Theo!");
  });

  it("renders a missing variable as empty (never as the literal braces)", () => {
    expect(renderTemplate("Hi {{name}}!", {})).toBe("Hi !");
    expect(renderTemplate("Hi {{unknown}}!", { name: "x" })).toBe("Hi !");
  });

  it("accepts numbers and stringifies them", () => {
    expect(renderTemplate("{{daysCount}} day(s)", { daysCount: 2 })).toBe("2 day(s)");
    expect(renderTemplate("{{n}}", { n: 0.5 })).toBe("0.5");
  });

  it("makes ONE pass — a value containing {{…}} is never re-substituted", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "boom" })).toBe("{{b}}");
  });

  it("leaves text without placeholders untouched (incl. lone braces)", () => {
    expect(renderTemplate("no placeholders here", {})).toBe("no placeholders here");
    expect(renderTemplate("{ single } braces stay", {})).toBe("{ single } braces stay");
    expect(renderTemplate("{{1number}} {{9}} stay", {})).toBe("{{1number}} {{9}} stay");
  });
});

describe("P24 — placeholder extraction + the unknown audit", () => {
  it("lists placeholders unique, in first-seen order", () => {
    expect(templatePlaceholders("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
    expect(templatePlaceholders("{{ a }} and {{b}}")).toEqual(["a", "b"]);
    expect(templatePlaceholders("none")).toEqual([]);
  });

  it("flags names outside the known vocabulary", () => {
    expect(unknownPlaceholders("Hi {{nam}}!", ["name"])).toEqual(["nam"]);
    expect(unknownPlaceholders("Hi {{name}}!", ["name"])).toEqual([]);
  });

  it("audits each field separately for the save action", () => {
    const audit = unknownPlaceholdersByField("LEAVE_PENDING", {
      subject: "Hi {{requesterName}}",
      body: "Duration: {{days}} — {{duration}}",
      title: "Leave request",
      message: "{{requesterName}} asked for {{dayz}}",
    });
    const byField = Object.fromEntries(audit.map((a) => [a.field, a.unknown]));
    expect(byField.subject).toEqual([]);
    expect(byField.body).toEqual(["duration"]);
    expect(byField.title).toEqual([]);
    expect(byField.message).toEqual(["dayz"]);
  });
});

describe("P24 — resolution (row → default)", () => {
  it("falls back to the registry default for a missing row", () => {
    const resolved = resolveNotificationTemplate(undefined, "LEAVE_PENDING");
    expect(resolved.subject).toBe("Leave request awaiting your approval");
    expect(resolved).toEqual(getNotificationTemplateEvent("LEAVE_PENDING")!.defaults);
  });

  it("falls back when the rows array exists but has no matching event", () => {
    const resolved = resolveNotificationTemplate([{ eventKey: "OTHER", subjectTemplate: "s", bodyTemplate: "b", titleTemplate: "t", messageTemplate: "m" }], "LEAVE_PENDING");
    expect(resolved.subject).toBe("Leave request awaiting your approval");
  });

  it("an override row wins WHOLE — all four fields, never per-field", () => {
    const resolved = resolveNotificationTemplate(
      [{
        eventKey: "LEAVE_PENDING",
        subjectTemplate: "SUBJ",
        bodyTemplate: "BODY",
        titleTemplate: "TITLE",
        messageTemplate: "MSG",
      }],
      "LEAVE_PENDING",
    );
    expect(resolved).toEqual({ subject: "SUBJ", body: "BODY", title: "TITLE", message: "MSG" });
  });
});

// ---------------------------------------------------------------------------
// The zero-behavior-change pin.
// ---------------------------------------------------------------------------

describe("P24 — the registry defaults render the pre-P24 strings byte-identically", () => {
  const pendingFacts = {
    requesterName: "Theo Vance",
    typeName: "Annual Leave",
    startDate: "2027-06-07",
    endDate: "2027-06-08",
    days: 2,
  };
  const pendingVars = {
    requesterName: pendingFacts.requesterName,
    typeName: pendingFacts.typeName,
    startDate: pendingFacts.startDate,
    endDate: pendingFacts.endDate,
    daysCount: pendingFacts.days,
    days: formatLeaveDays(pendingFacts.days),
  };

  it("LEAVE_PENDING: email subject + body == the leave-email builders", () => {
    const tpl = resolveNotificationTemplate(undefined, "LEAVE_PENDING");
    expect(renderTemplate(tpl.subject, pendingVars)).toBe(leavePendingEmailSubject());
    expect(renderTemplate(tpl.body, pendingVars)).toBe(leavePendingEmailText(pendingFacts));
  });

  it("LEAVE_PENDING: the in-app title/message == the literals the writer used", () => {
    const tpl = resolveNotificationTemplate(undefined, "LEAVE_PENDING");
    expect(renderTemplate(tpl.title, pendingVars)).toBe("Leave request awaiting your approval");
    expect(renderTemplate(tpl.message, pendingVars)).toBe(
      "Theo Vance requested 2 day(s) of Annual Leave (2027-06-07 → 2027-06-08).",
    );
  });

  const decidedFacts = {
    requesterName: "Theo",
    typeName: "Sick Leave",
    startDate: "2026-11-02",
    endDate: "2026-11-02",
    days: 0.5,
  };
  const decidedBase = {
    requesterName: decidedFacts.requesterName,
    typeName: decidedFacts.typeName,
    startDate: decidedFacts.startDate,
    endDate: decidedFacts.endDate,
    daysCount: decidedFacts.days,
    days: formatLeaveDays(decidedFacts.days),
  };

  it("LEAVE_DECIDED: email body == the builder, with and without a note, approve and reject", () => {
    const tpl = resolveNotificationTemplate(undefined, "LEAVE_DECIDED");
    for (const decision of ["APPROVE", "REJECT"] as const) {
      for (const note of ["", "Capacity crunch"]) {
        const vars = {
          ...decidedBase,
          decision: decision === "APPROVE" ? "approved" : "rejected",
          deciderName: "Ingrid",
          noteSuffix: note ? ` Note: ${note}` : "",
          noteClose: note ? `: ${note}` : ".",
        };
        expect(renderTemplate(tpl.body, vars)).toBe(
          leaveDecidedEmailText(decidedFacts, decision, "Ingrid", note),
        );
      }
    }
    expect(renderTemplate(tpl.subject, decidedBase)).toBe(leaveDecidedEmailSubject());
  });

  it("LEAVE_DECIDED: the in-app title/message == the literals the writer used", () => {
    const tpl = resolveNotificationTemplate(undefined, "LEAVE_DECIDED");
    const approveVars = {
      ...decidedBase,
      decision: "approved",
      deciderName: "Ingrid",
      noteSuffix: " Note: Enjoy",
      noteClose: ": Enjoy",
    };
    expect(renderTemplate(tpl.title, approveVars)).toBe("Leave request approved");
    expect(renderTemplate(tpl.message, approveVars)).toBe(
      "Ingrid approved your 0.5-day Sick Leave request: Enjoy",
    );
    const rejectVars = {
      ...decidedBase,
      decision: "rejected",
      deciderName: "Ingrid",
      noteSuffix: "",
      noteClose: ".",
    };
    expect(renderTemplate(tpl.title, rejectVars)).toBe("Leave request rejected");
    expect(renderTemplate(tpl.message, rejectVars)).toBe(
      "Ingrid rejected your 0.5-day Sick Leave request.",
    );
  });
});

describe("P24 — registry sanity", () => {
  it("the registry is non-empty and key-unique", () => {
    const keys = NOTIFICATION_TEMPLATE_EVENTS.map((e) => e.eventKey);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("LEAVE_PENDING");
    expect(keys).toContain("LEAVE_DECIDED");
  });

  it("every default field references only that event's declared variables", () => {
    for (const def of NOTIFICATION_TEMPLATE_EVENTS) {
      const known = def.variables.map((v) => v.name);
      for (const field of ["subject", "body", "title", "message"] as const) {
        const unknown = unknownPlaceholders(def.defaults[field], known);
        expect(unknown, `${def.eventKey}.${field} references undeclared variables`).toEqual([]);
      }
    }
  });

  it("every default field is non-empty (a blank default could never be pinned)", () => {
    for (const def of NOTIFICATION_TEMPLATE_EVENTS) {
      expect(def.defaults.subject.length).toBeGreaterThan(0);
      expect(def.defaults.body.length).toBeGreaterThan(0);
      expect(def.defaults.title.length).toBeGreaterThan(0);
      expect(def.defaults.message.length).toBeGreaterThan(0);
    }
  });

  it("sampleTemplateVars carries a value for every declared variable", () => {
    for (const def of NOTIFICATION_TEMPLATE_EVENTS) {
      const samples = sampleTemplateVars(def.eventKey);
      for (const v of def.variables) {
        expect(typeof samples[v.name]).toBe("string");
        expect(samples[v.name].length).toBeGreaterThan(0);
      }
    }
  });

  it("unknown registry keys resolve to null / empty templates", () => {
    expect(getNotificationTemplateEvent("NOT_AN_EVENT")).toBeNull();
    const resolved = resolveNotificationTemplate([], "NOT_AN_EVENT");
    expect(resolved).toEqual({ subject: "", body: "", title: "", message: "" });
  });
});

describe("P24 — formatLeaveDays (the {{days}} variable's formatter)", () => {
  it("matches the leave-email builder's day formatting", () => {
    expect(formatLeaveDays(1)).toBe("1 day");
    expect(formatLeaveDays(2)).toBe("2 days");
    expect(formatLeaveDays(0.5)).toBe("0.5 days");
    expect(formatLeaveDays(1.25)).toBe("1.3 days");
  });
});
