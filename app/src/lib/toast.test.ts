import { describe, it, expect, vi, beforeEach } from "vitest";
import { toasts, toastError, dismiss } from "./toast.svelte";

describe("toast store", () => {
  beforeEach(() => {
    // clear any leftover toasts between tests
    for (const t of [...toasts()]) dismiss(t.id);
  });

  it("toastError pushes an error toast and returns a unique id", () => {
    const a = toastError("boom one");
    const b = toastError("boom two");
    expect(a).not.toBe(b);
    expect(toasts().map((t) => t.message)).toEqual(["boom one", "boom two"]);
    expect(toasts()[0].kind).toBe("error");
  });

  it("dismiss removes a toast by id; unknown id is a no-op", () => {
    const id = toastError("x");
    dismiss(-999); // no-op
    expect(toasts().length).toBe(1);
    dismiss(id);
    expect(toasts().length).toBe(0);
  });

  it("auto-dismisses after the timeout", () => {
    vi.useFakeTimers();
    try {
      toastError("temp");
      expect(toasts().length).toBe(1);
      vi.advanceTimersByTime(6000);
      expect(toasts().length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
