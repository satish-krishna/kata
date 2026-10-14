import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";

const diffLines = vi.hoisted(() => vi.fn());
vi.mock("diff", () => ({ diffLines }));

import DiffBody from "./DiffBody.svelte";

describe("DiffBody", () => {
  it("falls back to before / after blocks when the diff times out", () => {
    diffLines.mockReturnValue(undefined);
    const { container } = render(DiffBody, { oldText: "old text", newText: "new text" });
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
    expect(screen.getByText("old text")).toBeInTheDocument();
    expect(screen.getByText("new text")).toBeInTheDocument();
    expect(container.querySelector(".k-toolcard__dl")).toBeNull();
  });
});
