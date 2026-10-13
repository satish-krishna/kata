import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import ToolCard from "./ToolCard.svelte";
import { pairToolEvents, type ToolCall } from "$lib/toolcards";
import type { StreamEvent } from "$lib/events";

const callOf = (events: Record<string, unknown>[]): ToolCall => {
  const it = pairToolEvents(events as StreamEvent[])[0];
  if (it.kind !== "call") throw new Error("not a call");
  return it.call;
};
const use = (name: string, input?: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: "tool.use", name, input_summary: `${name} summary`, id: "i", ...(input !== undefined ? { input } : {}), ...extra });
const res = (name: string, ok = true, extra: Record<string, unknown> = {}) =>
  ({ type: "tool.result", name, ok, summary: `${name} result summary`, id: "i", ...extra });

describe("ToolCard", () => {
  it("renders an Edit open, as a diff, with a status label", () => {
    const { container } = render(ToolCard, { call: callOf([
      use("Edit", { file_path: "src/claim.rs", old_string: "if now > t {", new_string: "if now >= t {" }),
      res("Edit"),
    ]) });
    expect(screen.getByText("src/claim.rs")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(container.querySelector(".k-toolcard__dl--del")).toHaveTextContent("if now > t {");
    expect(container.querySelector(".k-toolcard__dl--add")).toHaveTextContent("if now >= t {");
  });

  it("renders a Read collapsed and opens it on click", async () => {
    render(ToolCard, { call: callOf([use("Read", { file_path: "a.rs" }), res("Read", true, { output: "1\tfn main() {}" })]) });
    expect(screen.queryByText("1\tfn main() {}", { normalizer: (s) => s })).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: /Read/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("1\tfn main() {}", { normalizer: (s) => s })).toBeInTheDocument();
  });

  it("opens a failed Edit and shows the error under the diff", () => {
    render(ToolCard, { call: callOf([
      use("Edit", { file_path: "a.rs", old_string: "x", new_string: "y" }),
      res("Edit", false, { output: "old_string not found" }),
    ]) });
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("old_string not found")).toBeInTheDocument();
  });

  it("shows a running call with its label and no body", () => {
    render(ToolCard, { call: callOf([use("Bash", { command: "cargo test" })]) });
    expect(screen.getByText("running…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Bash/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("renders a TodoWrite as a checklist", () => {
    const { container } = render(ToolCard, { call: callOf([use("TodoWrite", { todos: [
      { content: "reproduce", status: "completed" },
      { content: "fix", status: "in_progress" },
      { content: "ship", status: "pending" },
    ] }), res("TodoWrite")]) });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(container.querySelector(".k-toolcard__todo-item--completed")).toHaveTextContent("reproduce");
    expect(container.querySelector(".k-toolcard__todo-item--in_progress")).toHaveTextContent("fix");
  });

  it("nests a subagent's calls inside its body", async () => {
    render(ToolCard, { call: callOf([
      use("Agent", { subagent_type: "Explore", description: "find checks", prompt: "Find every expiry check" }, { id: "A" }),
      { type: "tool.use", name: "Grep", input_summary: "expires_at", id: "B", parent_id: "A", input: { pattern: "expires_at" } },
      { type: "tool.result", name: "Grep", ok: true, summary: "7", id: "B", parent_id: "A", output: "a.rs:1" },
      { type: "tool.result", name: "Agent", ok: true, summary: "done", id: "A", output: "lease.rs has the bug" },
    ]) });
    await fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
    expect(screen.getByText("Find every expiry check")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Grep/ })).toBeInTheDocument();
    expect(screen.getByText("lease.rs has the bug")).toBeInTheDocument();
  });

  it("matches the older Task name for subagents", () => {
    render(ToolCard, { call: callOf([use("Task", { subagent_type: "general-purpose", description: "look" })]) });
    expect(screen.getByText("general-purpose: look")).toBeInTheDocument();
  });

  it("shows summaries when the run carried no payloads", async () => {
    render(ToolCard, { call: callOf([use("Edit"), res("Edit")]) });
    await fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getAllByText("Edit summary").length).toBeGreaterThan(0);
    expect(screen.getByText("Edit result summary")).toBeInTheDocument();
  });

  it("marks a truncated output", async () => {
    render(ToolCard, { call: callOf([use("Read", { file_path: "big.min.js" }), res("Read", true, { output: "x", truncated: true })]) });
    await fireEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByText("… truncated at 256 KB")).toBeInTheDocument();
  });

  it("skips non-object MultiEdit elements instead of crashing", () => {
    const { container } = render(ToolCard, { call: callOf([
      use("MultiEdit", { file_path: "a.rs", edits: [null, { old_string: "a", new_string: "b" }] }),
      res("MultiEdit"),
    ]) });
    expect(container.querySelectorAll(".k-toolcard__diff")).toHaveLength(1);
  });
});
