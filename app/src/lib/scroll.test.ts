import { describe, it, expect } from "vitest";
import { isAtBottom } from "./scroll";

// A scrollable element is "at the bottom" when its scrolled-from-top distance
// plus its visible height reaches (within a small slop) its total content
// height. ObservePane uses this to decide whether to keep tailing new events
// or leave the reader where they scrolled to.
describe("isAtBottom", () => {
  it("is true when scrolled exactly to the bottom", () => {
    expect(isAtBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
  });

  it("is true when within the default slop of the bottom", () => {
    // 1000 - 780 - 200 = 20px from the bottom — close enough to count as tailing.
    expect(isAtBottom({ scrollTop: 780, scrollHeight: 1000, clientHeight: 200 })).toBe(true);
  });

  it("is false when scrolled up beyond the slop", () => {
    // 1000 - 500 - 200 = 300px from the bottom — the reader has scrolled away.
    expect(isAtBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 200 })).toBe(false);
  });

  it("is true for content shorter than the viewport (nothing to scroll)", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 })).toBe(true);
  });

  it("honours an explicit slop threshold", () => {
    const el = { scrollTop: 850, scrollHeight: 1000, clientHeight: 100 };
    // 1000 - 850 - 100 = 50px from bottom.
    expect(isAtBottom(el, 40)).toBe(false);
    expect(isAtBottom(el, 60)).toBe(true);
  });
});
