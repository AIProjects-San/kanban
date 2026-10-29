import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toggle } from "@/components/fernly/toggle";
import { EmptyState } from "@/components/fernly/empty-state";
import { RoleBadge } from "@/components/fernly/role-badge";

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
