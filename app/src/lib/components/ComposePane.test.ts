import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ComposePane from "./ComposePane.svelte";
import { defaultSpec } from "$lib/spec";
import type { RunSpec } from "../../bindings/RunSpec";
import { reactiveSpec } from "./spec-fixture.svelte";

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

/** Render the pane over a caller-owned spec so tests can assert the mutations
 *  the pane makes. The pane mutates the object it is handed. Needs a
 *  `$state`-proxied spec (see `spec-fixture.svelte.ts`) so a click that flips
 *  a nested field actually re-renders the template. */
function renderSpec(mutate: (s: RunSpec) => void = () => {}) {
  const spec = reactiveSpec(mutate);
  render(ComposePane, {
    spec,
    entries: [],
    onPickWorkdir: vi.fn(),
    presets: [],
    onSavePreset: vi.fn(),
  });
  return spec;
}

const ALLOW_PLACEHOLDER = "Read\nGrep\nBash(git *)";
// testing-library's default text matcher collapses whitespace (including
// newlines) before comparing, which would erase the very line breaks these
// tests exist to assert on — opt out for placeholder lookups on this field.
const allowPlaceholderOptions = { collapseWhitespace: false };

describe("ComposePane permissions — rule visibility", () => {
  it("hides the rule editors under bypass", () => {
    renderSpec();
    expect(screen.queryByPlaceholderText(ALLOW_PLACEHOLDER, allowPlaceholderOptions)).toBeNull();
  });

  it("shows the rule editors under prompt", async () => {
    renderSpec();
    await fireEvent.click(screen.getByRole("radio", { name: "prompt" }));
    expect(screen.getByPlaceholderText(ALLOW_PLACEHOLDER, allowPlaceholderOptions)).toBeInTheDocument();
  });

  it("drops blank lines when parsing rules", async () => {
    const spec = renderSpec((s) => (s.permissions.mode = "prompt"));
    const allow = screen.getByPlaceholderText(ALLOW_PLACEHOLDER, allowPlaceholderOptions);
    await fireEvent.input(allow, { target: { value: "Read\n\n  Grep  \n" } });
    expect(spec.permissions.allow).toEqual(["Read", "Grep"]);
  });

  it("clears entered rules when the mode flips back to bypass", async () => {
    const spec = renderSpec((s) => {
      s.permissions.mode = "prompt";
      s.permissions.allow = ["Read"];
      s.permissions.deny = ["Bash(rm *)"];
    });
    await fireEvent.click(screen.getByRole("radio", { name: "bypass" }));
    expect(spec.permissions.mode).toBe("bypass");
    expect(spec.permissions.allow).toEqual([]);
    expect(spec.permissions.deny).toEqual([]);
  });

  it("leaves rules alone when the mode is set to prompt", async () => {
    const spec = renderSpec((s) => {
      s.permissions.mode = "prompt";
      s.permissions.allow = ["Read"];
    });
    await fireEvent.click(screen.getByRole("radio", { name: "prompt" }));
    expect(spec.permissions.allow).toEqual(["Read"]);
  });
});
