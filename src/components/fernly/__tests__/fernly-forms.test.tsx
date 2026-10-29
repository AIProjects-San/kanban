import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CheckCircle2 } from "lucide-react";
import { Field, FormRow } from "@/components/fernly/field";
import { StatCard } from "@/components/fernly/stat-card";
import { PasswordInput, generatePassword } from "@/components/fernly/password-input";

describe("Field", () => {
  it("associates the label with the wrapped input", () => {
    render(
      <Field label="Email">
        <input id="email" aria-label="Email" />
      </Field>,
    );
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("renders optional hint text", () => {
    render(
      <Field label="Password" hint={<span role="note">At least 8 characters</span>}>
        <input aria-label="Password" type="password" />
      </Field>,
    );
    expect(screen.getByRole("note")).toHaveTextContent("At least 8 characters");
  });
});

describe("FormRow", () => {
  it("renders children inside a two-column grid", () => {
    const { container } = render(
      <FormRow>
        <div>A</div>
        <div>B</div>
      </FormRow>,
    );
    expect(container.firstChild).toHaveClass("grid", "grid-cols-2");
  });
});

describe("StatCard", () => {
  it("renders value and label in vertical layout", () => {
    render(
      <StatCard
        icon={CheckCircle2}
        value={42}
        label="Tasks done"
        iconColor="text-success"
        iconBg="bg-success/10"
      />,
    );
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("Tasks done")).toBeInTheDocument();
  });

  it("renders a delta badge when provided", () => {
    render(
      <StatCard
        icon={CheckCircle2}
        value={10}
        label="Projects"
        iconColor="text-primary"
        iconBg="bg-primary/10"
        delta="+12%"
        deltaType="up"
      />,
    );
    expect(screen.getByText("+12%")).toBeInTheDocument();
  });

  it("hides the delta badge when not provided", () => {
    render(
      <StatCard
        icon={CheckCircle2}
        value={10}
        label="Projects"
        iconColor="text-primary"
        iconBg="bg-primary/10"
      />,
    );
    expect(screen.queryByText("+12%")).not.toBeInTheDocument();
  });

  it("renders the horizontal layout variant", () => {
    const { container } = render(
      <StatCard
        icon={CheckCircle2}
        value={7}
        label="Events"
        iconColor="text-primary"
        iconBg="bg-primary/10"
        layout="horizontal"
      />,
    );
    expect(container.firstChild).toHaveClass("flex", "items-center");
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});

describe("generatePassword", () => {
  it("generates a 16-character password by default", () => {
    expect(generatePassword()).toHaveLength(16);
  });

  it("honours a custom length", () => {
    expect(generatePassword(24)).toHaveLength(24);
  });

  it("only uses the documented character set (no ambiguous chars)", () => {
    const pw = generatePassword(200);
    // Actual exclusions in the implementation: lowercase l, uppercase I and O,
    // digits 0 and 1. Everything else from A-Z/a-z/2-9 plus !@#$% is allowed.
    expect(pw).toMatch(/^[a-km-zA-HJ-NP-Z2-9!@#$%]+$/);
    expect(pw).not.toMatch(/[lIO01]/);
  });

  it("generates different passwords on each call", () => {
    const a = generatePassword(32);
    const b = generatePassword(32);
    expect(a).not.toBe(b);
  });
});

describe("PasswordInput", () => {
  it("toggles between hidden and visible password", async () => {
    const { user } = renderWithUser(
      <PasswordInput value="secret123" onChange={() => {}} placeholder="Password" />,
    );
    const input = screen.getByPlaceholderText("Password");
    expect(input).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: /show password/i }));
    expect(input).toHaveAttribute("type", "text");
  });
});

// -- helper ---------------------------------------------------------------
import userEvent from "@testing-library/user-event";
function renderWithUser(ui: React.ReactElement) {
  const user = userEvent.setup();
  return { user, ...render(ui) };
}
