import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import AskPanel from "./AskPanel.svelte";
import type { Question } from "$lib/events";

const single: Question = {
  kind: "select",
  header: "Store",
  question: "Which store?",
  options: [{ label: "Postgres" }, { label: "SQLite" }],
};
const multi: Question = { ...single, header: "Stores", multi_select: true };

const send = () => screen.getByRole("button", { name: "Send answer · resume" });

describe("AskPanel — Other option", () => {
  it("offers an Other row on every select question", () => {
    render(AskPanel, { id: "a1", questions: [single], onSubmit: vi.fn() });
    expect(screen.getByRole("button", { name: /Other/ })).toBeInTheDocument();
  });

  it("does not offer Other on a confirm question", () => {
    const confirm: Question = { kind: "confirm", header: "Go", question: "Proceed?" };
    render(AskPanel, { id: "a1", questions: [confirm], onSubmit: vi.fn() });
    expect(screen.queryByRole("button", { name: /Other/ })).not.toBeInTheDocument();
  });

  it("keeps send disabled while Other is picked but empty", async () => {
    render(AskPanel, { id: "a1", questions: [single], onSubmit: vi.fn() });
    await fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    expect(send()).toBeDisabled();
  });

  it("single-select: the typed text replaces the choice", async () => {
    const onSubmit = vi.fn();
    render(AskPanel, { id: "a1", questions: [single], onSubmit });
    await fireEvent.click(screen.getByRole("button", { name: /Postgres/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "  DuckDB  " } });
    await fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith("a1", [["DuckDB"]]);
  });

  it("single-select: picking a listed option after Other drops the typed text", async () => {
    const onSubmit = vi.fn();
    render(AskPanel, { id: "a1", questions: [single], onSubmit });
    await fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "DuckDB" } });
    await fireEvent.click(screen.getByRole("button", { name: /SQLite/ }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith("a1", [["SQLite"]]);
  });

  it("multi-select: the typed text joins the ticked options", async () => {
    const onSubmit = vi.fn();
    render(AskPanel, { id: "a1", questions: [multi], onSubmit });
    await fireEvent.click(screen.getByRole("button", { name: /Postgres/ }));
    await fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "DuckDB" } });
    await fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith("a1", [["Postgres", "DuckDB"]]);
  });

  it("answered view shows a custom answer as a selected Other row", () => {
    render(AskPanel, { id: "a1", questions: [single], answers: [["DuckDB"]] });
    expect(screen.getByText("DuckDB")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Other/ })).toHaveClass("k-ask__opt--selected");
  });

  it("answered view omits the Other row when every answer was a listed option", () => {
    render(AskPanel, { id: "a1", questions: [single], answers: [["SQLite"]] });
    expect(screen.queryByRole("button", { name: /Other/ })).not.toBeInTheDocument();
  });
});
