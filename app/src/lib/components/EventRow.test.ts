import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import EventRow from "./EventRow.svelte";

describe("EventRow markdown routing", () => {
  it("renders assistant.text markdown through MarkdownBody (shows .k-md and <strong>)", () => {
    const { container } = render(EventRow, {
      ev: { type: "assistant.text", text: "Result is **success**." },
    });
    expect(container.querySelector(".k-md")).not.toBeNull();
    expect(container.querySelector("strong")).not.toBeNull();
    expect(container.querySelector("strong")!.textContent).toBe("success");
  });

  it("renders tool.result as plain text — no .k-md wrapper", () => {
    const { container } = render(EventRow, {
      ev: { type: "tool.result", name: "Bash", ok: true, summary: "27 passed / 3 failed" },
    });
    expect(container.querySelector(".k-md")).toBeNull();
    expect(container.textContent).toContain("27 passed / 3 failed");
  });

  it("renders log events as plain text — no .k-md wrapper", () => {
    const { container } = render(EventRow, {
      ev: { type: "log", level: "info", message: "assembled plugin-dir: 1 skill" },
    });
    expect(container.querySelector(".k-md")).toBeNull();
    expect(container.textContent).toContain("assembled plugin-dir");
  });
});
