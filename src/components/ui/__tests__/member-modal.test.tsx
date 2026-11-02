// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// MemberModal — drift regression tests
//
// The original MemberModal had two tabs:
//   1. "Pick existing user" — pick from a list of users to add to the team
//      directory (links a User row to a TeamMember row).
//   2. "Create new" — call createMember() with name/email directly, creating
//      a TeamMember WITHOUT a User login account. This was the obsolete
//      "old option" that produced orphan team-directory entries.
//
// Tab #2 has been removed entirely. The modal now only offers the pick
// flow. These tests pin that contract.
// ---------------------------------------------------------------------------

const { getAllUsers, createMember } = vi.hoisted(() => ({
  getAllUsers: vi.fn(),
  createMember: vi.fn(),
}));

vi.mock("@/server-actions/data", () => ({
  getAllUsers,
  createMember,
}));

// Stub the Modal so we don't need to worry about portal/animation timing,
// but pass through the title/description so the modal's intent is visible
// in the rendered output.
vi.mock("@/components/ui/modal", () => ({
  Modal: ({
    children,
    open,
    title,
    description,
  }: {
    children: React.ReactNode;
    open: boolean;
    title?: string;
    description?: string;
  }) =>
    open ? (
      <div data-testid="modal">
        {title && <h2>{title}</h2>}
        {description && <p>{description}</p>}
        {children}
      </div>
    ) : null,
}));

import { MemberModal } from "@/components/ui/member-modal";
import { useApp } from "@/store/app-store";

beforeEach(() => {
  useApp.getState().closeMemberModal();
  useApp.getState().openMemberModal();
  getAllUsers.mockReset();
  createMember.mockReset();
});

describe("MemberModal: obsolete 'Create new' tab removal", () => {
  it("renders the modal title 'Add team member'", async () => {
    getAllUsers.mockResolvedValue({ ok: true, data: [] });
    render(<MemberModal />);
    await waitFor(() => {
      expect(screen.getByText("Add team member")).toBeInTheDocument();
    });
  });

  it("does NOT render the 'Create new' tab toggle (removed — old flow)", async () => {
    getAllUsers.mockResolvedValue({ ok: true, data: [] });
    render(<MemberModal />);
    await waitFor(() => {
      expect(screen.getByText("Add team member")).toBeInTheDocument();
    });
    // The old tab label was "Create new" — must be gone.
    expect(screen.queryByRole("button", { name: /^create new$/i })).toBeNull();
    // And the old "Pick existing user" tab is also gone (no toggle = single mode).
    expect(screen.queryByRole("button", { name: /pick existing user/i })).toBeNull();
  });

  it("does NOT render the 'Full name' / 'Email' fields from the old create-new form", async () => {
    getAllUsers.mockResolvedValue({ ok: true, data: [] });
    render(<MemberModal />);
    await waitFor(() => {
      expect(screen.getByText("Add team member")).toBeInTheDocument();
    });
    // The old create-new form had these placeholders.
    expect(screen.queryByPlaceholderText("Jordan Lee")).toBeNull();
    expect(screen.queryByPlaceholderText("jordan@fernly.app")).toBeNull();
  });

  it("shows the user-picker search input (the kept flow)", async () => {
    getAllUsers.mockResolvedValue({ ok: true, data: [] });
    render(<MemberModal />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search users…")).toBeInTheDocument();
    });
  });

  it("the create-label is 'Add to team' (was 'Add member' on the create-new path)", async () => {
    getAllUsers.mockResolvedValue({ ok: true, data: [] });
    render(<MemberModal />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /add to team/i })).toBeInTheDocument();
    });
    // The old create-new path's submit button ("Add member") is gone.
    expect(screen.queryByRole("button", { name: /^add member$/i })).toBeNull();
  });
});
