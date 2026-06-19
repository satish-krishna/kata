import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import DetailActions from "./DetailActions.svelte";

const cbs = () => ({ onReRun: vi.fn(), onOpenInCompose: vi.fn(), onExportBundle: vi.fn() });

describe("DetailActions", () => {
  it("disables every action and explains why on the hoverable container when the kata is unsaved", () => {
    const { container } = render(DetailActions, { kataSaved: false, ...cbs() });
    for (const name of [/re-run/i, /open in compose/i, /export bundle/i]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    // The hint sits on the container (disabled buttons don't fire hover events).
    expect(container.querySelector(".wb-detail__actions")).toHaveAttribute(
      "title",
      expect.stringContaining("not in the library"),
    );
  });

  it("enables actions with no tooltip when the kata is saved", () => {
    const { container } = render(DetailActions, { kataSaved: true, ...cbs() });
    expect(screen.getByRole("button", { name: /re-run/i })).toBeEnabled();
    expect(container.querySelector(".wb-detail__actions")).not.toHaveAttribute("title");
  });

  it("fires the matching callback on click when enabled", async () => {
    const c = cbs();
    render(DetailActions, { kataSaved: true, ...c });
    await fireEvent.click(screen.getByRole("button", { name: /open in compose/i }));
    expect(c.onOpenInCompose).toHaveBeenCalledOnce();
  });
});
