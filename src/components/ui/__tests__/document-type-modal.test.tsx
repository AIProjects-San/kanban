// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Recruitment R4 — document-type template editor modal
// (docs/RECRUITMENT_MODULE_PLAN.md §5 R4). hiring:config surface: list the
// checklist template, add a type, edit, delete. Mirrors the hiring-stage
// modal suite.
// ---------------------------------------------------------------------------

const { getDocumentTypes, saveDocumentType, deleteDocumentType } = vi.hoisted(() => ({
  getDocumentTypes: vi.fn(),
  saveDocumentType: vi.fn(),
  deleteDocumentType: vi.fn(),
}));

vi.mock("@/server-actions/hiring-formalities", () => ({
  getDocumentTypes,
  saveDocumentType,
  deleteDocumentType,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="modal-stub">{children}</div> : null,
}));

import { DocumentTypeModal } from "@/components/ui/document-type-modal";
import type { DocumentTypeConfigT } from "@/lib/types";

const TYPES: DocumentTypeConfigT[] = [
  { id: "dt-1", key: "id_proof", label: "ID Document", description: "Passport or ID", isMandatory: true, scope: "CANDIDATE", sortOrder: 10, isActive: true },
  { id: "dt-2", key: "bank_details", label: "Bank Details", description: "", isMandatory: false, scope: "CANDIDATE", sortOrder: 20, isActive: true },
];

const onChanged = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getDocumentTypes.mockResolvedValue({ ok: true, data: TYPES });
});

describe("DocumentTypeModal", () => {
  it("lists the configured types with mandatory badges", async () => {
    render(<DocumentTypeModal open onClose={onClose} onChanged={onChanged} />);
    const list = await screen.findByTestId("doc-type-list");
    expect(list.textContent).toContain("ID Document");
    expect(list.textContent).toContain("Bank Details");
    expect(list.textContent).toContain("mandatory");
    expect(list.textContent).toContain("id_proof");
  });

  it("adds a type via the draft form (key auto-slugged from the label)", async () => {
    saveDocumentType.mockResolvedValue({ ok: true, data: { id: "dt-new" } });
    render(<DocumentTypeModal open onClose={onClose} onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId("add-doc-type-btn"));
    const label = screen.getByLabelText(/Label/);
    fireEvent.change(label, { target: { value: "Right to Work" } });
    // Key is auto-derived while typing a NEW type.
    expect((screen.getByLabelText(/Key \(auto from label\)/) as HTMLInputElement).value).toBe("right_to_work");
    fireEvent.click(screen.getByLabelText(/Mandatory/));
    fireEvent.submit(screen.getByTestId("doc-type-draft-form"));
    await waitFor(() =>
      expect(saveDocumentType).toHaveBeenCalledWith(
        expect.objectContaining({ key: "right_to_work", label: "Right to Work", isMandatory: true }),
      ),
    );
  });

  it("surfaces a save error as a toast and keeps the draft", async () => {
    saveDocumentType.mockResolvedValue({ ok: false, code: "VALIDATION", error: "A key is required." });
    const { toast } = await import("sonner");
    render(<DocumentTypeModal open onClose={onClose} onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId("add-doc-type-btn"));
    fireEvent.change(screen.getByLabelText(/Label/), { target: { value: "X" } });
    fireEvent.submit(screen.getByTestId("doc-type-draft-form"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A key is required."));
    expect(screen.getByTestId("doc-type-draft-form")).toBeTruthy();
  });

  it("deletes a type through the row action", async () => {
    deleteDocumentType.mockResolvedValue({ ok: true, data: { ok: true } });
    render(<DocumentTypeModal open onClose={onClose} onChanged={onChanged} />);
    await screen.findByTestId("doc-type-list");
    fireEvent.click(screen.getByTestId("delete-doc-type-bank_details"));
    await waitFor(() =>
      expect(deleteDocumentType).toHaveBeenCalledWith({ id: "dt-2" }),
    );
  });

  it("renders the empty state when no types are configured", async () => {
    getDocumentTypes.mockResolvedValue({ ok: true, data: [] });
    render(<DocumentTypeModal open onClose={onClose} onChanged={onChanged} />);
    expect(await screen.findByText(/No document types yet/)).toBeTruthy();
  });
});
