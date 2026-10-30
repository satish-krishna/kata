// The document layout of the change page's Intent tab, measured in a real browser. A short intent has no `##` headings, so its outline
// column has nothing to list; the column must not be drawn, and the text then starts at the left edge with the strip's inset instead of
// 260px in with nothing to its left. jsdom has no layout, so only a browser can see where the text starts.
import { installClipping } from './clipping.mjs';

/** A change whose intent has no `##` headings. */
export const SHORT_INTENT_ROUTE = 'sdlc/commerce/2026-10-12-product-photo-upload';
/** The most the text's left edge may be from the page's left edge, in pixels. */
const MAX_LEFT = 40;

/** Opens the short intent at one width; returns the failures as readable lines. */
export async function checkDocLayoutLeft(browser, origin, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await installClipping(context);
  const page = await context.newPage();
  const fails = [];
  const at = `the intent of ${SHORT_INTENT_ROUTE} at ${width}`;
  try {
    await page.goto(`${origin}/${SHORT_INTENT_ROUTE}`, { waitUntil: 'networkidle' });
    await page.locator('app-sdlc-toolbar header [role="tab"]', { hasText: 'Intent' }).first().click();
    await page.locator('.k-docview__text').first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => {
      const text = document.querySelector('.k-docview__text').getBoundingClientRect();
      return {
        left: text.left,
        outline: document.querySelectorAll('.k-docview nav[aria-label="On this page"]').length,
        headings: document.querySelectorAll('.k-docview__text h2, .k-docview__text h3').length,
      };
    });
    if (m.headings !== 0) fails.push(`${at}: the fixture changed, the intent now has ${m.headings} second or third level headings`);
    if (m.outline !== 0) fails.push(`${at}: an outline is drawn for a document with no sections`);
    if (!(m.left <= MAX_LEFT)) fails.push(`${at}: the text starts ${m.left.toFixed(2)}px from the left edge, more than ${MAX_LEFT}px`);
  } finally {
    await context.close();
  }
  return fails;
}
