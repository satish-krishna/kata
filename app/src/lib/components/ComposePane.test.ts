import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ComposePane from "./ComposePane.svelte";
import { defaultSpec } from "$lib/spec";
import type { RunSpec } from "../../bindings/RunSpec";
// `proxy` is Svelte's internal `$state` primitive, exposed via the
// `svelte/internal/client` entry point. In the real app the compose route
// wraps its spec in `$state(...)` (see `+page.svelte`), which deep-proxies
// nested writes so `{#if spec.permissions.mode === "prompt"}` re-renders
// when a click flips the mode. A plain object handed to `render()` here has
// no such proxy — @testing-library/svelte only makes the top-level props
// record reactive (see its `createProps`), not nested fields — so a click
// that mutates `spec.permissions.mode` in place would never reach the
// template. Proxying the spec the same way `$state` does keeps these tests
// exercising the pane through real clicks instead of only asserting on the
// mutated object.
// @ts-expect-error — svelte/internal/client ships no type declarations; it is
// Svelte's own runtime, not a documented public API.
import { proxy } from "svelte/internal/client";

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
 *  the pane makes. The pane mutates the object it is handed. */
function renderSpec(mutate: (s: RunSpec) => void = () => {}) {
  const spec = proxy(defaultSpec());
  mutate(spec);
  render(ComposePane, {
    spec,
    entries: [],
    onPickWorkdir: vi.fn(),
    presets: [],
    onSavePreset: vi.fn(),
  });
  return spec;
}

// Svelte collapses the source's `&#10;` entity references in this static
// attribute to plain spaces at compile time, so the rendered placeholder is
// single-line — match what the DOM actually carries, not the source text.
const ALLOW_PLACEHOLDER = "Read Grep Bash(git *)";

describe("ComposePane permissions — rule visibility", () => {
  it("hides the rule editors under bypass", () => {
    renderSpec();
    expect(screen.queryByPlaceholderText(ALLOW_PLACEHOLDER)).toBeNull();
  });

  it("shows the rule editors under prompt", async () => {
    renderSpec();
    await fireEvent.click(screen.getByRole("radio", { name: "prompt" }));
    expect(screen.getByPlaceholderText(ALLOW_PLACEHOLDER)).toBeInTheDocument();
  });

  it("drops blank lines when parsing rules", async () => {
    const spec = renderSpec((s) => (s.permissions.mode = "prompt"));
    const allow = screen.getByPlaceholderText(ALLOW_PLACEHOLDER);
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
