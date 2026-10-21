// The AI-SDLC workspace home page, measured in a real browser at the widths `check:responsive` runs it at (1024 is the window's minimum).
// Nothing on the page may be cut off: every visible element lies inside every ancestor that clips or scrolls it sideways (a control
// hidden behind a scrolling table is still cut off), and no element that truncates its text with an ellipsis truncates it here.
// Clipping is measured with scripts/clipping.mjs, never with scrollWidth - clientWidth.
import { installClipping } from './clipping.mjs';

export const HOME_ROUTE = 'sdlc';

/** Runs in the page: returns plain data about what is cut off. */
function measure() {
  const { textClipped, isInside } = window.kataClip;
  const home = document.querySelector('app-sdlc-home');
  if (!home) return null;
  const sideways = (r) => ({ left: r.left, right: r.right, top: 0, bottom: 0 });
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/)[0]}` : ''} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32)}"`;
  const cut = [];
  const truncated = [];
  for (const el of home.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden], [aria-hidden="true"]')) continue;
    let hiddenBy = null;
    for (let a = el.parentElement; a && !hiddenBy; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox !== 'visible' && !isInside(sideways(r), sideways(a.getBoundingClientRect()))) hiddenBy = a;
    }
    if (!hiddenBy && !isInside(sideways(r), { left: 0, right: window.innerWidth, top: 0, bottom: 0 })) hiddenBy = document.documentElement;
    if (hiddenBy) cut.push(`${label(el)} spans ${r.left.toFixed(2)}-${r.right.toFixed(2)}, cut by ${label(hiddenBy).slice(0, 40)} (${hiddenBy.getBoundingClientRect().left.toFixed(2)}-${hiddenBy.getBoundingClientRect().right.toFixed(2)})`);
    if ((cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden') && el.childNodes.length > 0 && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const over = textClipped(el);
      if (over > 0) truncated.push(`${label(el)} is cut by ${over.toFixed(2)}px`);
    }
  }
  const root = document.documentElement;
  return { cut, truncated, pageScroll: root.scrollWidth - root.clientWidth };
}

/** Opens the home page at one width; returns the failures as readable lines. */
export async function checkHomePage(browser, origin, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await installClipping(context);
  const page = await context.newPage();
  const fails = [];
  try {
    await page.goto(`${origin}/${HOME_ROUTE}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.locator('app-changes-table, app-repos-table').first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(200);
    const m = await page.evaluate(measure);
    const at = `the workspace home page at ${width}`;
    if (m === null) return [`${at}: no home page rendered`];
    if (m.pageScroll > 1) fails.push(`${at}: the page scrolls sideways by ${m.pageScroll}px`);
    for (const c of m.cut) fails.push(`${at}: cut off: ${c}`);
    for (const t of m.truncated) fails.push(`${at}: truncated text: ${t}`);
  } finally {
    await context.close();
  }
  return fails;
}
