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
