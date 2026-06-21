/** The scroll geometry isAtBottom needs — a real Element satisfies this. */
export type ScrollMetrics = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

/**
 * Whether a scrollable element is at (or within `slop` px of) its bottom.
 *
 * Used to decide whether to keep tailing appended content: tail only when the
 * reader is already at the bottom, so streaming events (or a pending ask) never
 * yank them back down while they're reading earlier content. The slop absorbs
 * sub-pixel rounding and small trailing gaps.
 */
export function isAtBottom(el: ScrollMetrics, slop = 32): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slop;
}
