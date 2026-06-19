import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import Toolbar from "./Toolbar.svelte";

// The required callbacks; individual tests add the run/cancel handlers they need.
const baseProps = () => ({ name: "demo", dirty: false, onNew: vi.fn(), onOpen: vi.fn(), onSave: vi.fn() });

describe("Toolbar", () => {
  it("links to the library route", () => {
    render(Toolbar, baseProps());
    expect(screen.getByRole("link", { name: /library/i })).toHaveAttribute("href", "/library");
  });

  it("shows Run, not Cancel, when not running", () => {
    render(Toolbar, { ...baseProps(), running: false, onRun: vi.fn() });
    expect(screen.getByRole("button", { name: /run/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });

  it("swaps Run for Cancel when running", () => {
    render(Toolbar, { ...baseProps(), running: true, onCancel: vi.fn() });
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
  });

  it("disables Run when canRun is false", () => {
    render(Toolbar, { ...baseProps(), canRun: false, onRun: vi.fn() });
    expect(screen.getByRole("button", { name: /run/i })).toBeDisabled();
  });

  it("fires onRun when Run is clicked", async () => {
    const onRun = vi.fn();
    render(Toolbar, { ...baseProps(), onRun });
    await fireEvent.click(screen.getByRole("button", { name: /run/i }));
    expect(onRun).toHaveBeenCalledOnce();
  });
});
