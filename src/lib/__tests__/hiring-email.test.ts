import { describe, it, expect } from "vitest";

// R3 — rejection-email template tests (src/lib/hiring-email.ts). The core
// contract: the INTERNAL rejectReason never appears in the email; only the
// HR-approved remarks do. Plus greeting derivation and HTML escaping.

import { composeRejectionEmail, firstNameOf } from "@/lib/hiring-email";

describe("firstNameOf", () => {
  it("takes the first given name", () => {
    expect(firstNameOf("Priyanka Menon")).toBe("Priyanka");
    expect(firstNameOf("Nadia Petrova")).toBe("Nadia");
  });

  it("keeps single names and falls back for blanks", () => {
    expect(firstNameOf("Cher")).toBe("Cher");
    expect(firstNameOf("   ")).toBe("there");
    expect(firstNameOf("")).toBe("there");
  });

  it("collapses extra whitespace", () => {
    expect(firstNameOf("  Sam   Whitaker ")).toBe("Sam");
  });
});

describe("composeRejectionEmail", () => {
  const base = {
    candidateName: "Elena Moreau",
    position: "Backend Engineer",
    workspaceName: "Fernly Workspace",
    remarks: "",
  };

  it("mentions the position + workspace in the subject", () => {
    const email = composeRejectionEmail(base);
    expect(email.subject).toBe("Update on your application — Backend Engineer at Fernly Workspace");
  });

  it("greets by first name, thanks, decides, and signs off", () => {
    const email = composeRejectionEmail(base);
    expect(email.text).toContain("Hi Elena,");
    expect(email.text).toContain("Thank you for taking the time to apply for the Backend Engineer role");
    expect(email.text).toContain("we have decided not to move forward");
    expect(email.text).toContain("The Fernly Workspace Hiring Team");
  });

  it("merges HR-approved remarks into both parts when present", () => {
    const email = composeRejectionEmail({ ...base, remarks: "Please apply again for mid-level openings." });
    expect(email.text).toContain("Please apply again for mid-level openings.");
    expect(email.html).toContain("Please apply again for mid-level openings.");
  });

  it("omits the remarks paragraph entirely when blank (no stray blank lines)", () => {
    const email = composeRejectionEmail(base);
    expect(email.text).not.toContain("  \n\n\n");
    expect(email.html).not.toMatch(/<p>\s*<\/p>/);
  });

  it("escapes HTML in the position and remarks; the greeting uses only the safe first name (F-07)", () => {
    const email = composeRejectionEmail({
      candidateName: "Eve <script>alert(1)</script>",
      position: "Engineer & Team Lead",
      workspaceName: "Fernly Workspace",
      remarks: 'Great work on "<b>the challenge</b>"',
    });
    // The greeting takes the FIRST name only — the injected markup is
    // dropped entirely, never escaped-into-place.
    expect(email.html).toContain("Hi Eve,");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("alert(1)");
    expect(email.html).toContain("Engineer &amp; Team Lead");
    expect(email.html).toContain("&lt;b&gt;the challenge&lt;/b&gt;");
  });

  it("falls back to a generic role wording when position is blank", () => {
    const email = composeRejectionEmail({ ...base, position: "   " });
    expect(email.subject).toContain("role at Fernly Workspace");
    expect(email.text).toContain("apply for the role at");
  });

  it("falls back to the app name when the workspace name is blank", () => {
    const email = composeRejectionEmail({ ...base, workspaceName: "" });
    expect(email.text).toContain("The Fernly Hiring Team");
  });
});

// ---------------------------------------------------------------------------
// F2.10 (F-R10) — the interview-invite composer (the INTERVIEW_INVITE
// outbox kind's text). A reschedule re-sends ON PURPOSE: the email carries
// the new time.
// ---------------------------------------------------------------------------

import { composeInterviewInviteEmail } from "@/lib/hiring-email";

describe("composeInterviewInviteEmail", () => {
  const when = new Date("2026-11-12T14:00:00.000Z");
  const base = {
    candidateName: "Tomas Eriksen",
    position: "QA Engineer",
    stageLabel: "Interview 1 — Technical",
    workspaceName: "Fernly Workspace",
    when,
    durationMin: 60,
    interviewerName: "Ingrid Solberg",
  };

  it("subject names the position + workspace; the body carries stage, time, duration and interviewer", () => {
    const email = composeInterviewInviteEmail(base);
    expect(email.subject).toBe("Interview invitation — QA Engineer at Fernly Workspace");
    expect(email.text).toContain("Stage: Interview 1 — Technical");
    expect(email.text).toContain("(60 minutes)");
    expect(email.text).toContain("With: Ingrid Solberg");
    // The when label is weekday + short date + time (the first thing a
    // candidate scans).
    expect(email.text).toMatch(/When: \w{3}, 12 Nov 2026, \d{2}:\d{2}/);
    expect(email.text).toContain("reply to this email");
  });

  it("html escapes candidate-controlled and HR-typed fields (F-07 discipline)", () => {
    const email = composeInterviewInviteEmail({
      ...base,
      position: "QA & Release",
      interviewerName: 'Ingrid "The Detail" Solberg',
    });
    expect(email.html).toContain("QA &amp; Release");
    expect(email.html).toContain("&quot;The Detail&quot;");
    expect(email.html).not.toContain('"The Detail"');
  });

  it("omits the interviewer line when unknown; defaults duration to 60", () => {
    const email = composeInterviewInviteEmail({
      candidateName: "Tomas Eriksen",
      position: "",
      stageLabel: "Interview 1",
      workspaceName: "Fernly Workspace",
      when,
      durationMin: Number.NaN,
    });
    expect(email.text).not.toContain("With:");
    expect(email.text).toContain("(60 minutes)");
    // Blank position → generic subject, never "the  role".
    expect(email.subject).toBe("Interview invitation — Interview 1 at Fernly Workspace");
  });

  it("an invalid date degrades to \"to be confirmed\", never \"Invalid Date\"", () => {
    const email = composeInterviewInviteEmail({ ...base, when: new Date("not-a-date") });
    expect(email.text).toContain("When: to be confirmed");
    expect(email.text).not.toContain("Invalid Date");
  });
});
