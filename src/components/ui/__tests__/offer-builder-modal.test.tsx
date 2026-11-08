// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Recruitment R5 — offer builder modal: generate from a template, negotiate
// components with live totals, save the DRAFT (docs/RECRUITMENT_MODULE_PLAN.md).
// ---------------------------------------------------------------------------

const { getOfferTemplates, getOfferRecords, createOfferRecord, updateOfferRecord, sendOffer } = vi.hoisted(() => ({
  getOfferTemplates: vi.fn(),
  getOfferRecords: vi.fn(),
  createOfferRecord: vi.fn(),
  updateOfferRecord: vi.fn(),
  sendOffer: vi.fn(),
}));

vi.mock("@/server-actions/hiring", () => ({
  getOfferTemplates,
  getOfferRecords,
  createOfferRecord,
  updateOfferRecord,
  sendOffer,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="modal-stub">{children}</div> : null,
}));

import { OfferBuilderModal } from "@/components/ui/offer-builder-modal";
import type { CandidateT, CandidateStageT, OfferRecordT, OfferTemplateT } from "@/lib/types";

function stage(): CandidateStageT {
  return {
    id: "st-1", stageKey: "offer", label: "Offer & Signature", stageType: "OFFER",
    ownerUserId: null, ownerName: null, status: "PENDING", scheduledAt: null,
    remarks: "", rating: null, strengths: "", concerns: "", recommendation: null,
    eventId: null, sortOrder: 70, startedAt: null, completedAt: null,
  };
}

const CANDIDATE: CandidateT = {
  id: "cand-1", fullName: "Priyanka Menon", email: "p@x.co", phone: "",
  position: "Product Designer", department: "DESIGN", source: "", resumeUrl: "",
  notes: "", status: "SELECTED", rejectReason: "", decidedAt: "2026-11-10T00:00:00.000Z",
  createdById: "u-hr", userId: null, joinedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z", stages: [stage()],
};

const TEMPLATE: OfferTemplateT = {
  id: "ot-1", key: "designer", label: "Designer Band", description: "",
  components: [
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68_000 },
    { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3 },
  ],
  benefits: ["4 weeks annual leave"], letterTemplate: "Hi {{candidateName}} — {{annualCtc}}",
  isActive: true, sortOrder: 10,
};

function offer(overrides: Partial<OfferRecordT> = {}): OfferRecordT {
  return {
    id: "or-1", candidateId: "cand-1", candidateName: "Priyanka Menon",
    position: "Product Designer", templateId: "ot-1", templateLabel: "Designer Band",
    components: TEMPLATE.components, benefits: TEMPLATE.benefits,
    letterText: "Hi Priyanka Menon — $70,040", status: "DRAFT", notes: "",
    createdBy: "Remy", createdAt: "2026-11-11T00:00:00.000Z", updatedAt: "2026-11-11T00:00:00.000Z",
    token: null, tokenExpiresAt: null, signedAt: null, signedName: "",
    approvedBy: null, approvedAt: null, startDate: "",
    ...overrides,
  };
}

const onChanged = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getOfferTemplates.mockResolvedValue({ ok: true, data: [TEMPLATE] });
  getOfferRecords.mockResolvedValue({ ok: true, data: [] });
});

describe("OfferBuilderModal", () => {
  it("shows the generate picker for a SELECTED candidate and creates a draft", async () => {
    createOfferRecord.mockResolvedValue({ ok: true, data: { id: "or-new" } });
    getOfferRecords
      .mockResolvedValueOnce({ ok: true, data: [] }) // initial load
      .mockResolvedValueOnce({ ok: true, data: [offer({ id: "or-new" })] }); // after generate
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);

    const select = await screen.findByTestId("offer-template-select");
    fireEvent.change(select, { target: { value: "ot-1" } });
    fireEvent.click(screen.getByTestId("generate-offer-btn"));
    await waitFor(() =>
      expect(createOfferRecord).toHaveBeenCalledWith({ candidateId: "cand-1", templateId: "ot-1" }),
    );
  });

  it("renders existing offers with status + CTC; DRAFT opens the editor with live totals", async () => {
    getOfferRecords.mockResolvedValue({ ok: true, data: [offer()] });
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    expect(await screen.findByTestId("offer-row-or-1")).toBeTruthy();

    fireEvent.click(screen.getByTestId("edit-offer-or-1"));
    const editor = await screen.findByTestId("offer-editor");
    // Component labels render as input values, not text.
    const labelInput = editor.querySelector('input[placeholder*="Label"]') as HTMLInputElement;
    expect(labelInput.value).toBe("Basic Salary");
    // Live totals: 68,000 + 2,040 employer = 70,040 CTC; net 68,000.
    const totals = await screen.findByTestId("offer-totals");
    expect(totals.textContent).toContain("$70,040");
    expect(totals.textContent).toContain("$68,000");
  });

  it("saving the draft sends the edited components + letter", async () => {
    getOfferRecords.mockResolvedValue({ ok: true, data: [offer()] });
    updateOfferRecord.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    await screen.findByTestId("offer-row-or-1");
    fireEvent.click(screen.getByTestId("edit-offer-or-1"));
    await screen.findByTestId("offer-editor");

    // Bump the basic to 70,000 via the first amount input.
    const amountInputs = screen.getAllByLabelText("Amount");
    fireEvent.change(amountInputs[0], { target: { value: "70000" } });
    fireEvent.click(screen.getByTestId("save-offer-btn"));
    await waitFor(() =>
      expect(updateOfferRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "or-1",
          components: expect.arrayContaining([
            expect.objectContaining({ key: "basic", amount: 70_000 }),
          ]),
          benefits: ["4 weeks annual leave"],
        }),
      ),
    );
  });

  it("hides the generate picker for non-SELECTED candidates", async () => {
    getOfferRecords.mockResolvedValue({ ok: true, data: [offer()] });
    render(
      <OfferBuilderModal
        open candidate={{ ...CANDIDATE, status: "HIRED" }} onClose={onClose} onChanged={onChanged}
      />,
    );
    await screen.findByTestId("offer-row-or-1");
    expect(screen.queryByTestId("generate-offer-btn")).toBeNull();
  });

  it("shows the empty state when the candidate has no offers", async () => {
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    expect(await screen.findByText(/No offer yet/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// R6 — send: APPROVED → SENT mints the signing link (displayed + copyable).
// F2.10: the Send button lives on the APPROVED row; a DRAFT shows the
// awaiting-manager-approval hint instead.
// ---------------------------------------------------------------------------

describe("OfferBuilderModal: R6 send", () => {
  it("Send on an APPROVED offer calls sendOffer and surfaces the signing link", async () => {
    sendOffer.mockResolvedValue({ ok: true, data: { token: "tok-abc123" } });
    getOfferRecords.mockResolvedValue({
      ok: true,
      data: [offer({ status: "APPROVED", approvedBy: "Ingrid Solberg", approvedAt: "2026-11-14T09:00:00.000Z" })],
    });
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    await screen.findByTestId("offer-row-or-1");

    fireEvent.click(screen.getByTestId("send-offer-or-1"));
    await waitFor(() =>
      expect(sendOffer).toHaveBeenCalledWith({ offerId: "or-1" }),
    );
    const box = await screen.findByTestId("offer-link-box");
    expect(box.textContent).toContain("tok-abc123");
    expect(screen.getByTestId("offer-sign-link").textContent).toContain("/offer/tok-abc123");
  });

  it("a DRAFT shows the awaiting-approval hint instead of a Send button (F2.10)", async () => {
    getOfferRecords.mockResolvedValue({ ok: true, data: [offer()] });
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    await screen.findByTestId("awaiting-approval-or-1");
    expect(screen.queryByTestId("send-offer-or-1")).toBeNull();
  });

  it("an APPROVED row shows the approval trail (who + when + start date)", async () => {
    getOfferRecords.mockResolvedValue({
      ok: true,
      data: [offer({
        status: "APPROVED", approvedBy: "Ingrid Solberg", approvedAt: "2026-11-14T09:00:00.000Z",
        startDate: "2026-11-29",
      })],
    });
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    const trail = await screen.findByTestId("approved-by-or-1");
    expect(trail.textContent).toContain("Ingrid Solberg");
    expect(trail.textContent).toContain("proposed start");
  });

  it("a failed send surfaces the error and keeps the offer editable", async () => {
    sendOffer.mockResolvedValue({ ok: false, error: "Offer is already SENT." });
    getOfferRecords.mockResolvedValue({
      ok: true,
      data: [offer({ status: "APPROVED", approvedBy: "Ingrid", approvedAt: "2026-11-14T09:00:00.000Z" })],
    });
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    await screen.findByTestId("offer-row-or-1");

    fireEvent.click(screen.getByTestId("send-offer-or-1"));
    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Offer is already SENT."));
    expect(screen.queryByTestId("offer-link-box")).toBeNull();
  });

  it("a SENT offer shows the awaiting-signature line + signing-link button; SIGNED shows the signer", async () => {
    getOfferRecords.mockResolvedValue({
      ok: true,
      data: [
        offer({
          id: "or-sent", status: "SENT", token: "tok-live", tokenExpiresAt: "2026-11-20T00:00:00.000Z",
        }),
        offer({
          id: "or-signed", status: "SIGNED", token: "tok-done",
          signedAt: "2026-11-14T10:30:00.000Z", signedName: "Priyanka Menon",
        }),
      ],
    });
    render(<OfferBuilderModal open candidate={CANDIDATE} onClose={onClose} onChanged={onChanged} />);
    const sent = await screen.findByTestId("offer-row-or-sent");
    expect(sent.textContent).toContain("Awaiting signature");
    expect(screen.getByTestId("copy-link-or-sent")).toBeTruthy();

    const signed = screen.getByTestId("offer-row-or-signed");
    expect(signed.textContent).toContain("Signed by Priyanka Menon");
    // Signed records are immutable — no copy-link, no send.
    expect(screen.queryByTestId("copy-link-or-signed")).toBeNull();
    expect(screen.queryByTestId("send-offer-or-signed")).toBeNull();
  });
});
