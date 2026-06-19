import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import DetailActions from "./DetailActions.svelte";

const cbs = () => ({ onReRun: vi.fn(), onOpenInCompose: vi.fn(), onExportBundle: vi.fn() });

describe("DetailActions", () => {
  it("disables every action and explains why when the kata is unsaved", () => {
    render(DetailActions, { kataSaved: false, ...cbs() });
    for (const name of [/re-run/i, /open in compose/i, /export bundle/i]) {
      const btn = screen.getByRole("button", { name });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("title", expect.stringContaining("not in the library"));
    }
  });

  it("enables actions with no tooltip when the kata is saved", () => {
    render(DetailActions, { kataSaved: true, ...cbs() });
    const btn = screen.getByRole("button", { name: /re-run/i });
    expect(btn).toBeEnabled();
    expect(btn).not.toHaveAttribute("title");
  });

  it("fires the matching callback on click when enabled", async () => {
    const c = cbs();
    render(DetailActions, { kataSaved: true, ...c });
    await fireEvent.click(screen.getByRole("button", { name: /open in compose/i }));
    expect(c.onOpenInCompose).toHaveBeenCalledOnce();
  });
});
