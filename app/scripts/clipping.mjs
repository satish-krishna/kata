// The one clipping measure every browser check shares.
//
// `scrollWidth - clientWidth` is a whole-pixel number: a text a fraction of a pixel wider than its box still reads as fitting
// while the browser paints an ellipsis. The two functions below compare fractional rects instead.
//
//   textClipped(el, box?)  how many pixels of the element's text lie beyond its box (0 when the text fits). The text is measured
//                          with a Range over the element's contents, the box is the element's content box (`'content'`, for an
//                          element that clips its overflow) or its border box (`'border'`, for one that lets text spill into its padding).
//   isInside(inner, outer) whether a box lies inside its container, from fractional rects. Either argument is an element or a rect.
//
// textClipped tolerates 0.01px and isInside 0.02px (layout positions are in 1/64px), below which the difference is rounding. They run inside the page, so they are plain functions with
// no free variables; `CLIPPING_SOURCE` carries them as text and `installClipping` puts them on `window.kataClip` before the page's own scripts.

export function textClipped(el, box = 'content') {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return 0;
  const cs = getComputedStyle(el);
  const inset = (...sides) => sides.reduce((sum, side) => sum + (parseFloat(cs[side]) || 0), 0);
  const room = box === 'border' ? rect.width : rect.width - inset('paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth');
  const range = document.createRange();
  range.selectNodeContents(el);
  const over = range.getBoundingClientRect().width - room;
  return over > 0.01 ? over : 0;
}

export function isInside(inner, outer, tolerance = 0.02) {
  const a = inner instanceof Element ? inner.getBoundingClientRect() : inner;
  const b = outer instanceof Element ? outer.getBoundingClientRect() : outer;
  return a.left >= b.left - tolerance && a.right <= b.right + tolerance && a.top >= b.top - tolerance && a.bottom <= b.bottom + tolerance;
}

export const CLIPPING_SOURCE = `${textClipped.toString()}\n${isInside.toString()}\nwindow.kataClip = { textClipped, isInside };`;

/** Puts `window.kataClip` in every page of a browser context (or of one page) that is opened or navigated afterwards. */
export function installClipping(target) {
  return target.addInitScript({ content: CLIPPING_SOURCE });
}
