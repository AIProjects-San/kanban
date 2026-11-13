"use server";

// ---------------------------------------------------------------------------
// R6 tail — markJoined (split from hiring.ts): the signed candidate becomes
// an employee. Creates the account (deterministic <first>.<last>@domain
// email), EmployeeProfile, TeamMember roster entry, salary structure copied
// from the signed offer (F-R7), onboarding checklist from the unified
// template source (F-R8), and queues a welcome email. Idempotent per
// candidate. The joining gate (F-R9/E5) enforces VERIFIED mandatory
// documents + terminal background checks when enabled.
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import crypto from "node:crypto";
import { db } from "@/lib/infra/db";
import { requirePermission, AuthorizationError } from "./auth-guard";
import { logAudit, sendOutboxMail, readOnboardingTemplate, instantiateChecklist } from "./shared";
import { nextEmployeeNumber } from "./hr-shared";
import { toResult } from "./result";
import type { ActionResult } from "@/lib/action-result";
import { getWorkspaceConfig } from "@/lib/infra/config-loader";
import { parseComponents } from "@/lib/offer-math";
import { evaluateJoiningGate } from "@/lib/hiring/joining-gate";
import { holidayLookupFrom } from "@/lib/working-days";
import { hashPassword } from "@/lib/auth/password";
import { escapeHtml } from "@/lib/utils";

/** The deterministic account email for a joining hire:
 * <first>.<last>@hiringEmailDomain, lowercased ASCII; collisions get a
 * numeric suffix (priyanka.menon2@…). */
function buildHireEmail(fullName: string, domain: string): string {
  const parts = fullName.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").split(".");
  const handle = parts.slice(0, 2).join(".") || "new.hire";
  return `${handle}@${domain}`;
}

async function nextAvailableHireEmail(fullName: string, domain: string): Promise<string> {
  const base = buildHireEmail(fullName, domain);
  let candidate = base;
  let n = 2;
  // Small workspaces: a linear probe is plenty; the unique constraint is the
  // final guard inside the transaction.
  while (true) {
    const existing = await db.user.findUnique({ where: { email: candidate }, select: { id: true } });
    if (!existing) return candidate;
    const [handle, dom] = base.split("@");
    candidate = `${handle}${n}@${dom}`;
    n += 1;
  }
}

/** Mark a signed candidate as Joined: creates the employee's account
 * (deterministic email), EmployeeProfile, roster entry, salary structure
 * copied from the signed offer (F2.10 / F-R7 — no joiner is silently
 * unpaid), onboarding checklist instantiated from the ONE template source
 * (F-R8), then queues the welcome email. Idempotent per candidate.
 *
 * F2.10 (F-R9/E5) — the joining gate: when Workspace.joiningGateEnabled,
 * every ACTIVE+MANDATORY document type must have a VERIFIED document and
 * every background check must be terminal, mirroring the benchmark's
 * required_for_employee_creation. The refusal lists exactly what is
 * outstanding. */
export async function markJoined(input: { candidateId: string }): Promise<ActionResult<{
  userId: string;
  email: string;
  mailStatus: string;
  workspaceName: string;
  /** F2.10 (F-R7) — false only when the signed offer carried no components
   * (the joiner is then visibly NOT payroll-ready — the UI warns loudly). */
  payrollReady: boolean;
  /** F2.10 (F-R8) — the instantiated template tasks, so the day-one handout
   * prints the real checklist instead of a third hard-coded copy. */
  checklistTasks: { title: string; dueOffsetDays: number }[];
}>> {
  return toResult(async () => {
    const auth = await requirePermission("hiring:manage");
    const candidateId = String(input?.candidateId ?? "").trim();
    if (!candidateId) throw new AuthorizationError("A candidate id is required.");
    const candidate = await db.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) throw new AuthorizationError("Candidate not found.");
    if (candidate.userId) {
      throw new AuthorizationError(`${candidate.fullName} already joined (account exists).`);
    }
    if (candidate.status !== "SELECTED") {
      throw new AuthorizationError("Only selected candidates can be marked as joined.");
    }
    const signedOffer = await db.offerRecord.findFirst({
      where: { candidateId: candidate.id, status: "SIGNED" },
      orderBy: { signedAt: "desc" },
    });
    if (!signedOffer) {
      throw new AuthorizationError("The candidate must sign their offer before joining (no SIGNED offer found).");
    }

    const config = await getWorkspaceConfig();

    // F2.10 — the joining gate (F-R9/E5). Same pure rule the formalities
    // panel renders, enforced here where it actually bites.
    if (config.workspace.joiningGateEnabled) {
      const [docTypes, documents, bgChecks] = await Promise.all([
        // P36 — CANDIDATE-scope only (employee identification types never
        // gate a join).
        db.documentTypeConfig.findMany({ where: { scope: "CANDIDATE" }, orderBy: { sortOrder: "asc" } }),
        db.candidateDocument.findMany({ where: { candidateId: candidate.id } }),
        db.backgroundCheck.findMany({ where: { candidateId: candidate.id } }),
      ]);
      const gate = evaluateJoiningGate({ docTypes, documents, bgChecks });
      if (!gate.allowed) {
        throw new AuthorizationError(
          `Joining blocked — outstanding formalities: ${gate.blockers.join("; ")}.`,
        );
      }
    }

    const domain = config.workspace.hiringEmailDomain || "fernly.app";
    const email = await nextAvailableHireEmail(candidate.fullName, domain);
    // Random one-time password — never emailed; the hire sets their own via
    // the existing password-reset flow (welcome mail points them there).
    const passwordHash = await hashPassword(crypto.randomBytes(24).toString("base64url"));

    // F2.10 (F-R7) — the offer→structure mapping (createStructureFromOffer's
    // catalog discipline, inlined so it rides markJoined's transaction):
    // catalog codes canonicalize label/kind/mode, unseen codes
    // auto-register, the AMOUNT always stays the offer's actual.
    const offerComponents = parseComponents(signedOffer.components);
    const catalogRows = await db.salaryComponent.findMany({
      select: { code: true, label: true, kind: true, mode: true },
    });
    const catalogByCode = new Map(catalogRows.map((r) => [r.code, r]));
    const toRegister = offerComponents.filter((c) => !catalogByCode.has(c.key));
    const mappedComponents = offerComponents.map((c) => {
      const cat = catalogByCode.get(c.key);
      return cat
        ? { ...c, label: cat.label, kind: cat.kind as (typeof c)["kind"], mode: cat.mode as (typeof c)["mode"] }
        : c;
    });

    // F2.10 (F-R8) — the ONE template source.
    const template = await readOnboardingTemplate("ONBOARDING");

    // P35 (EM-12) — markJoined runs ON the join day: the checklist's
    // working-day anchor is today, and the walk skips the holiday calendar
    // (window capped like every read — PR-21 discipline).
    const joinDay = new Date();
    const walkEnd = new Date(joinDay.getTime());
    walkEnd.setUTCDate(walkEnd.getUTCDate() + 370);
    const holidayRows = await db.holidayCalendarEntry.findMany({
      where: { date: { gte: joinDay, lte: walkEnd } },
      select: { date: true, isHalfDay: true },
      take: 500,
    });
    const holidays = holidayLookupFrom(holidayRows);

    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: candidate.fullName,
          passwordHash,
          role: "MEMBER",
        },
      });
      await tx.teamMember.create({
        data: {
          name: candidate.fullName,
          role: "MEMBER",
          department: candidate.department || config.workspace.defaultDepartment,
          email,
          userId: created.id,
        },
      });
      await tx.employeeProfile.create({
        data: {
          userId: created.id,
          // EM-B01 (S13) — the next number in the workspace series, read
          // inside the SAME transaction (a concurrent join racing the max
          // surfaces as a unique-violation the friendly error names).
          employeeNumber: await nextEmployeeNumber(tx),
          jobTitle: candidate.position || "",
          department: candidate.department || "",
          hireDate: new Date(),
        },
      });
      // F2.10 (F-R7) — copy the signed offer into an ACTIVE salary structure
      // inside the same transaction: the joiner is payroll-ready the moment
      // they exist (an offer without components skips this — visibly).
      let structureCreated = false;
      if (mappedComponents.length > 0) {
        for (const c of toRegister) {
          await tx.salaryComponent.create({
            data: {
              code: c.key,
              label: c.label,
              kind: c.kind,
              mode: c.mode,
              defaultAmount: c.amount,
              isActive: true,
              sortOrder: 1000,
            },
          });
        }
        await tx.salaryStructure.updateMany({
          where: { userId: created.id, isActive: true },
          data: { isActive: false },
        });
        await tx.salaryStructure.create({
          data: {
            userId: created.id,
            components: JSON.stringify(mappedComponents),
            notes: `Copied from the signed offer (${signedOffer.templateLabel || "custom"}) on joining.`,
            isActive: true,
            createdById: auth.userId,
          },
        });
        structureCreated = true;
      }
      // F2.10 (F-R8) — the shared instantiation (self tasks → the hire,
      // manager tasks → the hire's manager when one exists, else HR picks
      // up; the exact createChecklist discipline markJoined used to drift
      // from).
      await instantiateChecklist(tx, {
        newHireId: created.id,
        title: `${candidate.fullName} — onboarding`,
        kind: "ONBOARDING",
        template,
        startDate: joinDay,
        holidays,
      });
      await tx.candidate.update({
        where: { id: candidate.id },
        data: { status: "HIRED", userId: created.id, joinedAt: new Date() },
      });
      return { created, structureCreated };
    });

    // Welcome email → outbox (best-effort).
    const first = candidate.fullName.split(/\s+/)[0];
    const subject = `Welcome to ${config.workspace.name}, ${first}!`;
    const text =
      `Hi ${first},\n\n` +
      `Welcome aboard! Your account email is ${email}.\n` +
      `To set your password, open the app and use "Forgot password?" with that email.\n\n` +
      `Your onboarding checklist is waiting in the app — see you on day one!\n\n` +
      `The ${config.workspace.name} team`;
    const html =
      `<p>Hi ${escapeHtml(first)},</p>` +
      `<p>Welcome aboard! Your account email is <strong>${escapeHtml(email)}</strong>.</p>` +
      `<p>To set your password, open the app and use "Forgot password?" with that email.</p>` +
      `<p>Your onboarding checklist is waiting in the app — see you on day one!</p>` +
      `<p>The ${escapeHtml(config.workspace.name)} team</p>`;
    const { status: wstatus } = await sendOutboxMail({
      kind: "WELCOME",
      candidateId: candidate.id,
      toAddress: email,
      subject,
      text,
      html,
      sentById: auth.userId,
    });

    await logAudit({
      actor: auth,
      action: "hiring.candidate_joined",
      entityType: "CANDIDATE",
      entityId: candidate.id,
      entityLabel: candidate.fullName,
      detail: `${auth.name} marked "${candidate.fullName}" as joined — account ${email} created with onboarding checklist + welcome email (${wstatus})` +
        (user.structureCreated
          ? `; salary structure copied from the signed offer (${mappedComponents.length} components — payroll-ready).`
          : "; NO salary structure — the signed offer had no components, fix payroll manually."),
    });
    revalidatePath("/");
    // workspaceName rides along for the day-one handout (persona-audit
    // D-03): HR prints the joiner's sign-in instructions — the sheet needs
    // the workspace's display name alongside the account email. F2.10 adds
    // payrollReady + the instantiated tasks (F-R7/F-R8 — the handout's
    // first-two-weeks list is now data, not a third code copy).
    return {
      userId: user.created.id,
      email,
      mailStatus: wstatus,
      workspaceName: config.workspace.name,
      payrollReady: user.structureCreated,
      checklistTasks: template.map((t) => ({ title: t.title, dueOffsetDays: t.dueOffsetDays })),
    };
  });
}

