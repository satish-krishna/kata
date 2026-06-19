import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ComposePane from "./ComposePane.svelte";
import { defaultSpec } from "$lib/spec";

function renderWith(modelId: string | null) {
  const spec = defaultSpec();
  spec.model.id = modelId;
  return render(ComposePane, {
    spec,
    entries: [],
    onPickWorkdir: vi.fn(),
    presets: [],
    onSavePreset: vi.fn(),
  });
}

describe("ComposePane model selector", () => {
  it("shows the free-text field for a loaded pinned (custom) id", () => {
    renderWith("claude-opus-4-8");
    expect(screen.getByPlaceholderText("claude-opus-4-8")).toHaveValue("claude-opus-4-8");
  });

  it("stays in custom mode after clearing a loaded pinned id", async () => {
    renderWith("claude-opus-4-8");
    const input = screen.getByPlaceholderText("claude-opus-4-8");
    await fireEvent.input(input, { target: { value: "" } });
    // The free-text field must remain (not snap back to the default segment).
    expect(screen.getByPlaceholderText("claude-opus-4-8")).toBeInTheDocument();
  });

  it("shows no free-text field for an alias id", () => {
    renderWith("opus");
    expect(screen.queryByPlaceholderText("claude-opus-4-8")).toBeNull();
  });
});
