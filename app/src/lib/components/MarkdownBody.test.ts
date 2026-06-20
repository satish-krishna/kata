import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import MarkdownBody from "./MarkdownBody.svelte";

describe("MarkdownBody", () => {
  it("wraps output in a .k-md element", () => {
    const { container } = render(MarkdownBody, { md: "text" });
    expect(container.querySelector(".k-md")).not.toBeNull();
  });

  it("renders **bold** as <strong>", () => {
    const { container } = render(MarkdownBody, { md: "**bold**" });
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("bold");
  });

  it("renders _italic_ as <em>", () => {
    const { container } = render(MarkdownBody, { md: "_italic_" });
    expect(container.querySelector("em")).not.toBeNull();
  });

  it("renders # Heading as a heading element", () => {
    const { container } = render(MarkdownBody, { md: "# Title" });
    expect(container.querySelector("h1, h2, h3, h4, h5, h6")).not.toBeNull();
    expect(container.querySelector("h1, h2, h3, h4, h5, h6")!.textContent).toBe("Title");
  });

  it("renders `inline code` as <code>", () => {
    const { container } = render(MarkdownBody, { md: "use `fn()` here" });
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("fn()");
  });

  it("renders fenced code blocks as <pre><code>", () => {
    const { container } = render(MarkdownBody, {
      md: "```\nconsole.log('hi')\n```",
    });
    const preCode = container.querySelector("pre code");
    expect(preCode).not.toBeNull();
    expect(preCode!.textContent).toContain("console.log");
  });

  it("renders GFM pipe tables as <table> with <th> and <td>", () => {
    const { container } = render(MarkdownBody, {
      md: "| A | B |\n|---|---|\n| 1 | 2 |",
    });
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("th")).not.toBeNull();
    expect(container.querySelector("td")).not.toBeNull();
  });

  it("renders [text](url) links with the correct href", () => {
    const { container } = render(MarkdownBody, {
      md: "[kata](https://example.com)",
    });
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("href")).toBe("https://example.com");
  });

  it("does not execute <script> tags found in markdown content", () => {
    (window as unknown as Record<string, unknown>).__xss = undefined;
    render(MarkdownBody, {
      md: "<script>window.__xss = true</script>",
    });
    expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();
  });

  it("renders an empty string without throwing", () => {
    // ObservePane guards on {#if summary.result} so MarkdownBody never receives
    // null, but an empty string is a valid edge case worth covering.
    const { container } = render(MarkdownBody, { md: "" });
    expect(container.querySelector(".k-md")).not.toBeNull();
  });
});
