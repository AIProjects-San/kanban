import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toggle } from "@/components/ui/toggle";
import { EmptyState } from "@/components/ui/empty-state";
import { RoleBadge } from "@/components/ui/role-badge";
import { Modal } from "@/components/ui/modal";

describe("Toggle", () => {
  it("renders as an accessible switch with the current state", () => {
    render(<Toggle checked={false} onChange={() => {}} />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("invokes onChange with the inverted value on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={true} onChange={onChange} disabled />);
    const sw = screen.getByRole("switch");
    expect(sw).toBeDisabled();
    await user.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(<EmptyState title="No tasks yet" description="Create one to get started" />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    expect(screen.getByText("Create one to get started")).toBeInTheDocument();
  });

  it("renders an optional action", () => {
    render(
      <EmptyState
        title="Nothing here"
        action={<button>Add thing</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Add thing" })).toBeInTheDocument();
  });
});

describe("RoleBadge", () => {
  it("renders the human label for each role", () => {
    const { rerender } = render(<RoleBadge role="ADMIN" />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
    rerender(<RoleBadge role="MANAGER" />);
    expect(screen.getByText("Manager")).toBeInTheDocument();
    rerender(<RoleBadge role="MEMBER" />);
    expect(screen.getByText("Member")).toBeInTheDocument();
  });

  it("optionally shows the shield icon", () => {
    const { container } = render(<RoleBadge role="ADMIN" icon />);
    // lucide icons render as <svg> elements
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("hides the shield icon by default", () => {
    const { container } = render(<RoleBadge role="ADMIN" />);
    expect(container.querySelector("svg")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L-P1-18 — Modal accessibility (focus trap, aria-labelledby, aria-modal).
// ---------------------------------------------------------------------------

describe("Modal a11y (L-P1-18)", () => {
  it("does not render when open is false", () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Test">
        <p>body</p>
      </Modal>,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders with role=dialog, aria-modal=true, and aria-labelledby pointing at the title", () => {
    render(
      <Modal open={true} onClose={() => {}} title="Confirm delete">
        <p>body</p>
      </Modal>,
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const titleEl = document.getElementById(labelledBy!);
    expect(titleEl?.textContent).toBe("Confirm delete");
  });

  it("sets aria-describedby when a description is provided", () => {
    render(
      <Modal open={true} onClose={() => {}} title="T" description="A description">
        <p>body</p>
      </Modal>,
    );
    const dialog = document.querySelector('[role="dialog"]');
    const describedBy = dialog?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const descEl = document.getElementById(describedBy!);
    expect(descEl?.textContent).toBe("A description");
  });

  it("omits aria-describedby when no description is provided", () => {
    render(
      <Modal open={true} onClose={() => {}} title="T">
        <p>body</p>
      </Modal>,
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-describedby")).toBeNull();
  });

  it("the close button has an accessible label", () => {
    render(
      <Modal open={true} onClose={() => {}} title="T">
        <p>body</p>
      </Modal>,
    );
    const closeBtn = document.querySelector('button[aria-label]');
    expect(closeBtn?.getAttribute("aria-label")).toMatch(/close/i);
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open={true} onClose={onClose} title="T">
        <p>body</p>
      </Modal>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
