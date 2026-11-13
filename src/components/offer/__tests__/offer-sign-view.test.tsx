// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Recruitment R6 — the PUBLIC offer signing view (docs/RECRUITMENT_MODULE_PLAN.md
// §5 R6). The tokenized /offer/[token] page renders the letter + numbers
// exactly as HR sent them, captures the typed signature (name must match the
// candidate), and offers a one-click decline. No session is involved.
// ---------------------------------------------------------------------------

const { signOffer, declineOffer } = vi.hoisted(() => ({
  signOffer: vi.fn(),
  declineOffer: vi.fn(),
}));

vi.mock("@/server-actions/hiring-offers", () => ({ signOffer, declineOffer }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OfferSignView, OfferLinkInvalid, type PublicOfferT } from "@/components/offer/offer-sign-view";

const OFFER: PublicOfferT = {
  token: "tok-xyz",
  offerId: "or-1",
  candidateName: "Priyanka Menon",
  position: "Product Designer",
  workspaceName: "Fernly Workspace",
  templateLabel: "Designer Band",
  letterText: "Dear Priyanka Menon,\n\nWe are delighted to offer you the position of Product Designer.",
  components: [
    { key: "basic", label: "Basic Salary", kind: "EARNING", mode: "FIXED", amount: 68_000, resolved: 68_000 },
    { key: "kiwisaver", label: "KiwiSaver 3%", kind: "EMPLOYER_CONTRIBUTION", mode: "PERCENT_OF_BASIC", amount: 3, resolved: 2_040 },
  ],
  benefits: ["4 weeks annual leave", "NZD 1,500 conference budget"],
  totals: { earnings: 68_000, employerContributions: 2_040, deductions: 0, net: 68_000, ctc: 70_040 },
  expiresAt: "2026-11-20T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OfferSignView", () => {
  it("renders the letter, resolved components, benefits, and net/CTC totals", () => {
    render(<OfferSignView offer={OFFER} />);
    expect(screen.getByTestId("offer-letter").textContent).toContain("Product Designer");
    const comps = screen.getByTestId("offer-components");
    expect(comps.textContent).toContain("Basic Salary");
    expect(comps.textContent).toContain("$68,000");
    // Employer contribution shows its % of basic form.
    expect(comps.textContent).toContain("3% of basic");
    expect(comps.textContent).toContain("$2,040");
    expect(comps.textContent).toContain("$70,040");
    const benefits = screen.getByTestId("offer-benefits");
    expect(benefits.textContent).toContain("4 weeks annual leave");
  });

  it("signing with a mismatched name surfaces the server error and stays on the form", async () => {
    signOffer.mockResolvedValue({ ok: false, error: "Please type your full legal name exactly as it appears on the offer." });
    render(<OfferSignView offer={OFFER} />);
    fireEvent.change(screen.getByTestId("offer-sign-name"), { target: { value: "Priyanka M" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("offer-sign-submit"));
    });
    const { toast } = await import("sonner");
    expect(toast.error).toHaveBeenCalled();
    expect(signOffer).toHaveBeenCalledWith({ token: "tok-xyz", signedName: "Priyanka M" });
    // Still on the signing form — no terminal state.
    expect(screen.getByTestId("offer-sign-form")).toBeTruthy();
  });

  it("signing with the exact name records the signature and shows the signed state", async () => {
    signOffer.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<OfferSignView offer={OFFER} />);
    fireEvent.change(screen.getByTestId("offer-sign-name"), { target: { value: "priyanka menon" } });
    fireEvent.click(screen.getByTestId("offer-sign-submit"));
    await waitFor(() => expect(screen.getByTestId("offer-signed-state")).toBeTruthy());
    expect(signOffer).toHaveBeenCalledWith({ token: "tok-xyz", signedName: "priyanka menon" });
    // The form is gone — the token is consumed.
    expect(screen.queryByTestId("offer-sign-form")).toBeNull();
  });

  it("declining records the decision and shows the declined state", async () => {
    declineOffer.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<OfferSignView offer={OFFER} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("offer-decline-btn"));
    });
    await waitFor(() => expect(screen.getByTestId("offer-declined-state")).toBeTruthy());
    expect(declineOffer).toHaveBeenCalledWith({ token: "tok-xyz" });
    expect(screen.queryByTestId("offer-sign-form")).toBeNull();
  });

  it("reloading an already-signed link renders the recorded outcome (page passes initialOutcome)", () => {
    render(
      <OfferSignView
        offer={OFFER}
        initialOutcome="signed"
        signedAt="2026-11-14T10:30:00.000Z"
        signedName="Priyanka Menon"
      />,
    );
    const state = screen.getByTestId("offer-signed-state");
    expect(state.textContent).toContain("Recorded");
    expect(state.textContent).toContain("Priyanka Menon");
    // No sign form to consume twice.
    expect(screen.queryByTestId("offer-sign-form")).toBeNull();
    expect(signOffer).not.toHaveBeenCalled();
  });
});

describe("OfferLinkInvalid", () => {
  it("renders the server's friendly message with the single-use explanation", () => {
    render(<OfferLinkInvalid message="This offer link has expired — please ask HR to resend it." />);
    const box = screen.getByTestId("offer-invalid-state");
    expect(box.textContent).toContain("expired");
    expect(box.textContent).toContain("single-use");
  });
});

// ---------------------------------------------------------------------------
// F2.10 (R12) — the post-sign APPOINTMENT LETTER: the signed state renders
// a printable confirmation (letter snapshot + package + signature record)
// riding the .print-area / window.print() pattern.
// ---------------------------------------------------------------------------

describe("OfferSignView — the appointment letter (F2.10 / R12)", () => {
  it("the signed state renders the printable letter: heading, letter text, package, signature block + print button", () => {
    render(
      <OfferSignView
        offer={OFFER}
        initialOutcome="signed"
        signedAt="2026-11-14T10:30:00.000Z"
        signedName="Priyanka Menon"
      />,
    );
    const letter = screen.getByTestId("appointment-letter");
    expect(letter.textContent).toContain("Letter of Appointment");
    // The letter snapshot rides the sheet verbatim.
    expect(letter.textContent).toContain("We are delighted to offer you");
    // The package table with the CTC.
    const pkg = screen.getByTestId("appointment-letter-package");
    expect(pkg.textContent).toContain("Basic Salary");
    expect(pkg.textContent).toContain("$70,040");
    // The recorded signature block.
    const sig = screen.getByTestId("appointment-letter-signature");
    expect(sig.textContent).toContain("Accepted electronically");
    expect(sig.textContent).toContain("Priyanka Menon");
    expect(sig.textContent).toContain("14 Nov 2026");
    // The print affordance (window.print()).
    const printBtn = screen.getByTestId("appointment-letter-print");
    expect(printBtn).toBeTruthy();
  });

  it("the print button calls window.print()", () => {
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);
    try {
      render(
        <OfferSignView
          offer={OFFER}
          initialOutcome="signed"
          signedAt="2026-11-14T10:30:00.000Z"
          signedName="Priyanka Menon"
        />,
      );
      fireEvent.click(screen.getByTestId("appointment-letter-print"));
      expect(printSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the just-signed client path (no signedAt props) still renders the letter with the candidate's name", async () => {
    signOffer.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<OfferSignView offer={OFFER} />);
    fireEvent.change(screen.getByTestId("offer-sign-name"), { target: { value: "Priyanka Menon" } });
    fireEvent.click(screen.getByTestId("offer-sign-submit"));
    await waitFor(() => expect(screen.getByTestId("appointment-letter")).toBeTruthy());
    // Without a recorded signedName the letter falls back to the offer's
    // candidate name — never a blank signature block.
    expect(screen.getByTestId("appointment-letter-signature").textContent).toContain("Priyanka Menon");
  });
});
