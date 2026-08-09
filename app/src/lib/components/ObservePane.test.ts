import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ObservePane from "./ObservePane.svelte";
import { defaultSpec } from "$lib/spec";
import type { StreamEvent } from "$lib/events";
import type { PermissionRecord } from "$lib/run.svelte";

/* The pane is the wiring between the run store's data and the components that
 * draw it. The card and the row are each covered in isolation elsewhere
 * (PermissionPanel.test.ts, EventRow.test.ts); what only this file can catch is
 * the pane handing them the wrong data, or not rendering them at all. */

const PENDING: PermissionRecord = {
  id: "p1",
  tool: "Bash",
  input_summary: "git -C ./.kata/wt-3f9a diff --stat",
  decided: null,
};

const DECIDED_BY_RULE: StreamEvent = {
  type: "permission.decided",
  id: "d1",
  tool: "Bash",
  input_summary: "dotnet test --filter AuthTests.LoginExpiry",
  allow: true,
  decided_by: "allow-rule",
};

/** Props go under an explicit `props` key: testing-library reads a bare object
 *  as component options, and this pane's `events` prop collides with one. */
function renderPane(over: Record<string, unknown> = {}) {
  return render(ObservePane, {
    props: {
      runState: "running",
      events: [],
      spec: defaultSpec(),
      summary: null,
      asks: [],
      permissions: [],
      ...over,
    },
  });
}

describe("ObservePane — the approval card", () => {
  it("renders a card for an undecided permission record", () => {
    renderPane({ runState: "awaiting", permissions: [PENDING] });
    expect(screen.getByText("Allow this tool call?")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("git -C ./.kata/wt-3f9a diff --stat")).toBeInTheDocument();
    expect(screen.getByText("awaiting your decision")).toBeInTheDocument();
  });

  it("forwards the operator's verdict to onDecide with the record's id", async () => {
    const onDecide = vi.fn();
    renderPane({ runState: "awaiting", permissions: [PENDING], onDecide });
    await fireEvent.click(screen.getByRole("button", { name: "Allow · resume" }));
    expect(onDecide).toHaveBeenCalledWith("p1", true, null);
  });

  it("renders a settled record read-only, with no way to decide it again", () => {
    const onDecide = vi.fn();
    renderPane({
      permissions: [{ ...PENDING, decided: { allow: false, message: "not on this branch" } }],
      onDecide,
    });
    expect(screen.getByText("denied · run resumed")).toBeInTheDocument();
    expect(screen.getByText("not on this branch")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("keeps multiple checks distinct rather than collapsing them", () => {
    renderPane({
      runState: "awaiting",
      permissions: [
        PENDING,
        { id: "p2", tool: "Write", input_summary: "src/Auth/TokenValidator.cs", decided: null },
      ],
    });
    expect(screen.getAllByText("Allow this tool call?")).toHaveLength(2);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("git -C ./.kata/wt-3f9a diff --stat")).toBeInTheDocument();
    expect(screen.getByText("Write")).toBeInTheDocument();
    expect(screen.getByText("src/Auth/TokenValidator.cs")).toBeInTheDocument();
  });
});

describe("ObservePane — the audit row", () => {
  it("renders an auto-resolved allow as a success row naming the rule", () => {
    const { container } = renderPane({ events: [DECIDED_BY_RULE] });
    const row = container.querySelector(".k-event--result-ok");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("allowed");
    expect(row!.textContent).toContain("dotnet test --filter AuthTests.LoginExpiry");
    expect(row!.textContent).toContain("allow-rule");
  });

  it("renders an auto-resolved deny as an error row", () => {
    const { container } = renderPane({
      events: [{ ...DECIDED_BY_RULE, id: "d2", allow: false, decided_by: "deny-rule" }],
    });
    const row = container.querySelector(".k-event--result-err");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("denied");
    expect(row!.textContent).toContain("deny-rule");
  });

  it("shows an audit row and an open card together — the two paths are independent", () => {
    const { container } = renderPane({
      runState: "awaiting",
      events: [DECIDED_BY_RULE],
      permissions: [PENDING],
    });
    expect(container.querySelector(".k-event--result-ok")).not.toBeNull();
    expect(screen.getByText("Allow this tool call?")).toBeInTheDocument();
  });
});

describe("ObservePane — the empty state", () => {
  it("shows the empty state when nothing has arrived", () => {
    renderPane();
    expect(screen.getByText(/normalized event stream renders here/)).toBeInTheDocument();
  });

  it("does not show the empty state when only a permission card is present", () => {
    renderPane({ runState: "awaiting", permissions: [PENDING] });
    expect(screen.queryByText(/normalized event stream renders here/)).toBeNull();
  });
});
