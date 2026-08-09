import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import PermissionPanel from "./PermissionPanel.svelte";

const PENDING = {
  id: "p1",
  tool: "Bash",
  input_summary: "rm -rf build/",
};

describe("PermissionPanel — pending", () => {
  it("shows the tool, the input, and both verdict buttons", () => {
    render(PermissionPanel, { ...PENDING, onDecide: vi.fn() });
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("rm -rf build/")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Allow · resume" })).toBeEnabled();
  });

  it("sends (id, true, null) on allow", async () => {
    const onDecide = vi.fn();
    render(PermissionPanel, { ...PENDING, onDecide });
    await fireEvent.click(screen.getByRole("button", { name: "Allow · resume" }));
    expect(onDecide).toHaveBeenCalledWith("p1", true, null);
  });

  it("sends the trimmed reason on deny", async () => {
    const onDecide = vi.fn();
    render(PermissionPanel, { ...PENDING, onDecide });
    const reason = screen.getByRole("textbox");
    await fireEvent.input(reason, { target: { value: "  not on main  " } });
    await fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("p1", false, "not on main");
  });

  it("sends null rather than an empty reason on deny", async () => {
    const onDecide = vi.fn();
    render(PermissionPanel, { ...PENDING, onDecide });
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "   " } });
    await fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("p1", false, null);
  });

  it("renders an empty-input placeholder when there is no input summary", () => {
    render(PermissionPanel, { ...PENDING, input_summary: "", onDecide: vi.fn() });
    expect(screen.getByText("(no input)")).toBeInTheDocument();
  });
});

describe("PermissionPanel — settled", () => {
  it("marks the taken verdict, disables both buttons, and drops the textarea", () => {
    render(PermissionPanel, { ...PENDING, decided: { allow: true, message: null } });
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });
    expect(allow).toBeDisabled();
    expect(deny).toBeDisabled();
    expect(allow).toHaveClass("k-ask__confirm-btn--selected");
    expect(deny).not.toHaveClass("k-ask__confirm-btn--selected");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders the denial message and marks deny as taken", () => {
    render(PermissionPanel, {
      ...PENDING,
      decided: { allow: false, message: "not on this branch" },
    });
    expect(screen.getByText("not on this branch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveClass("k-ask__confirm-btn--selected");
  });

  it("labels the settled state as resumed", () => {
    render(PermissionPanel, { ...PENDING, decided: { allow: true, message: null } });
    expect(screen.getByText("allowed · run resumed")).toBeInTheDocument();
  });
});
