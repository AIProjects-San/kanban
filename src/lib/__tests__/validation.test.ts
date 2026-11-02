import { describe, it, expect } from "vitest";
import {
  createTaskSchema,
  updateTaskSchema,
  createProjectSchema,
  createMemberSchema,
  createEventSchema,
  sendMessageSchema,
  createReminderSchema,
  emailSchema,
  employeeProfileSchema,
  employeeProfileSelfSchema,
  createLeaveRequestSchema,
  createReviewSchema,
  parseOrThrow,
  validationError,
} from "@/lib/validation";

// ---------------------------------------------------------------------------
// P2-22 — runtime input validation via zod.
// Each entity family has a schema; every server action runs its input through
// `parseOrThrow` before touching the DB. These tests assert the schemas exist
// and reject the obvious garbage (empty titles, oversized payloads, bad
// emails, out-of-range numbers) without exercising the full server-action
// stack.
// ---------------------------------------------------------------------------

describe("createTaskSchema", () => {
  it("accepts a minimal valid task", () => {
    expect(createTaskSchema.safeParse({ title: "Write tests" }).success).toBe(true);
  });

  it("rejects an empty/whitespace title", () => {
    expect(createTaskSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("rejects titles longer than 200 chars", () => {
    expect(createTaskSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
  });

  it("accepts a fully-populated task", () => {
    const r = createTaskSchema.safeParse({
      title: "Test",
      description: "desc",
      status: "TODO",
      priority: "HIGH",
      tag: "QA",
      dueDate: "2026-01-01",
      projectId: "p-1",
      assigneeId: "m-1",
    });
    expect(r.success).toBe(true);
  });
});

describe("updateTaskSchema", () => {
  it("is the partial of createTaskSchema — accepts sparse updates", () => {
    expect(updateTaskSchema.safeParse({ title: "New" }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ status: "DONE" }).success).toBe(true);
    expect(updateTaskSchema.safeParse({}).success).toBe(true);
  });

  it("still rejects an over-long title even in update form", () => {
    expect(updateTaskSchema.safeParse({ title: "x".repeat(201) }).success).toBe(false);
  });
});

describe("createProjectSchema", () => {
  it("requires a name", () => {
    expect(createProjectSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: "Apollo" }).success).toBe(true);
  });

  it("rejects names longer than 200 chars", () => {
    expect(createProjectSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });
});

describe("createMemberSchema", () => {
  it("requires a name + valid email", () => {
    expect(createMemberSchema.safeParse({ name: "", role: "Dev", department: "X", email: "a@b.co" }).success).toBe(false);
    expect(createMemberSchema.safeParse({ name: "N", role: "Dev", department: "X", email: "nope" }).success).toBe(false);
    expect(createMemberSchema.safeParse({ name: "N", role: "Dev", department: "X", email: "a@b.co" }).success).toBe(true);
  });

  it("normalises the email to lowercase + trims whitespace", () => {
    const r = createMemberSchema.safeParse({
      name: "Nina", role: "Dev", department: "X", email: "  NINA@Fernly.DEV  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("nina@fernly.dev");
  });
});

describe("createEventSchema", () => {
  it("requires a title and date", () => {
    expect(createEventSchema.safeParse({ title: "", date: "2026-01-01" }).success).toBe(false);
    expect(createEventSchema.safeParse({ title: "X", date: "" }).success).toBe(false);
    expect(createEventSchema.safeParse({ title: "X", date: "2026-01-01" }).success).toBe(true);
  });

  it("rejects durations outside 5min–24h", () => {
    expect(createEventSchema.safeParse({ title: "X", date: "2026-01-01", durationMin: 4 }).success).toBe(false);
    expect(createEventSchema.safeParse({ title: "X", date: "2026-01-01", durationMin: 24 * 60 + 1 }).success).toBe(false);
    expect(createEventSchema.safeParse({ title: "X", date: "2026-01-01", durationMin: 30 }).success).toBe(true);
  });

  it("rejects non-integer durations", () => {
    expect(createEventSchema.safeParse({ title: "X", date: "2026-01-01", durationMin: 30.5 }).success).toBe(false);
  });
});

describe("sendMessageSchema", () => {
  it("requires a non-empty subject and body", () => {
    expect(sendMessageSchema.safeParse({
      direction: "OUT", senderName: "M", recipientName: "O", subject: "", body: "hi",
    }).success).toBe(false);
    expect(sendMessageSchema.safeParse({
      direction: "OUT", senderName: "M", recipientName: "O", subject: "hi", body: "",
    }).success).toBe(false);
  });

  it("rejects direction values outside IN/OUT", () => {
    expect(sendMessageSchema.safeParse({
      direction: "SIDEWAYS", senderName: "M", recipientName: "O", subject: "s", body: "b",
    }).success).toBe(false);
  });

  it("rejects bodies longer than 10_000 chars", () => {
    expect(sendMessageSchema.safeParse({
      direction: "OUT", senderName: "M", recipientName: "O", subject: "s", body: "x".repeat(10_001),
    }).success).toBe(false);
  });
});

describe("createReminderSchema", () => {
  it("requires a title and dueDate", () => {
    expect(createReminderSchema.safeParse({ title: "", dueDate: "2026-01-01" }).success).toBe(false);
    expect(createReminderSchema.safeParse({ title: "X", dueDate: "" }).success).toBe(false);
    expect(createReminderSchema.safeParse({ title: "X", dueDate: "2026-01-01" }).success).toBe(true);
  });
});

describe("emailSchema", () => {
  it("rejects obvious garbage", () => {
    for (const bad of ["", "nope", "a@", "@b.co", "a b@c.co", "a@b"]) {
      expect(emailSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts and normalises well-formed emails", () => {
    expect(emailSchema.safeParse("Ada@Fernly.DEV").data).toBe("ada@fernly.dev");
    expect(emailSchema.safeParse("  user@x.co  ").data).toBe("user@x.co");
  });
});

describe("parseOrThrow", () => {
  it("returns the parsed value on success", () => {
    const out = parseOrThrow(createTaskSchema, { title: "X" });
    expect(out.title).toBe("X");
  });

  it("throws an Error with the first issue's message on failure", () => {
    expect(() => parseOrThrow(createTaskSchema, { title: "" })).toThrow(/title/i);
  });

  it("throws an Error flagged as a ValidationError (so isActionError recognises it)", () => {
    try {
      parseOrThrow(createTaskSchema, { title: "" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).name).toBe("ValidationError");
    }
  });
});

describe("validationError", () => {
  it("builds an Error with name=ValidationError", () => {
    const e = validationError("bad input");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ValidationError");
    expect(e.message).toBe("bad input");
  });
});

// ---------------------------------------------------------------------------
// QA-10 / QA-10b — employee profile schemas (HR audit)
// ---------------------------------------------------------------------------

describe("employeeProfileSchema hireDate (QA-10b)", () => {
  it("accepts real calendar dates", () => {
    expect(employeeProfileSchema.safeParse({ hireDate: "2026-02-28" }).success).toBe(true);
    expect(employeeProfileSchema.safeParse({ hireDate: "2020-02-29" }).success).toBe(true); // leap year
  });

  it("rejects impossible calendar dates that pass the yyyy-mm-dd regex", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "9999-99-99", "2026-00-10", "2026-04-31"]) {
      const res = employeeProfileSchema.safeParse({ hireDate: bad });
      expect(res.success).toBe(false);
    }
  });

  it("still accepts null (clearing) and undefined (omitting)", () => {
    expect(employeeProfileSchema.safeParse({ hireDate: null }).success).toBe(true);
    expect(employeeProfileSchema.safeParse({}).success).toBe(true);
  });
});

describe("employeeProfileSelfSchema (QA-10)", () => {
  it("accepts exactly the contact fields", () => {
    const res = employeeProfileSelfSchema.safeParse({
      phone: "+64 21 555 0003",
      location: "Auckland, NZ",
      emergencyContactName: "Ada",
      emergencyContactPhone: "+64 9 555 0111",
      skills: "React, TypeScript",
    });
    expect(res.success).toBe(true);
  });

  it("rejects every HR-owned field", () => {
    for (const smuggle of [
      { jobTitle: "CTO" },
      { department: "MANAGEMENT" },
      { hireDate: "2020-01-01" },
      { notes: "self-promoted" },
    ]) {
      expect(employeeProfileSelfSchema.safeParse(smuggle).success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// QA-11b — the leave/review date schemas share the same real-calendar-date
// refinement (a regex-only check let "2026-02-30" through, which either
// blew up at the Prisma write or silently compared as NaN).
// ---------------------------------------------------------------------------

describe("createLeaveRequestSchema dates (QA-11b)", () => {
  it("rejects impossible calendar dates", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-04-31"]) {
      const res = createLeaveRequestSchema.safeParse({ leaveTypeId: "c" + "x".repeat(24), startDate: bad, endDate: "2026-03-01" });
      expect(res.success).toBe(false);
    }
    const badEnd = createLeaveRequestSchema.safeParse({ leaveTypeId: "c" + "x".repeat(24), startDate: "2026-03-01", endDate: "2026-02-30" });
    expect(badEnd.success).toBe(false);
  });

  it("accepts real dates including leap days", () => {
    const res = createLeaveRequestSchema.safeParse({ leaveTypeId: "c" + "x".repeat(24), startDate: "2028-02-29", endDate: "2028-03-01" });
    expect(res.success).toBe(true);
  });
});

describe("createReviewSchema dates (QA-11b)", () => {
  it("rejects impossible calendar dates", () => {
    const res = createReviewSchema.safeParse({ userId: "c" + "x".repeat(24), title: "Cycle", periodStart: "2026-02-30", periodEnd: "2026-12-31" });
    expect(res.success).toBe(false);
  });

  it("accepts a real period", () => {
    const res = createReviewSchema.safeParse({ userId: "c" + "x".repeat(24), title: "Cycle", periodStart: "2026-01-01", periodEnd: "2026-12-31" });
    expect(res.success).toBe(true);
  });
});
