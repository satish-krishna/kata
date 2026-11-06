// Steady layouts: places on the AI-SDLC pages where two things that sit side by side must keep a gap, or wrap instead of overlapping.
// Each part opens its own page(s) from `browser` and `origin` and returns its failures as readable lines. Run one or more directly
// with `node scripts/check-steady-layouts.mjs --only done-row` (after `npm run build`); `check:responsive` runs every part.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, serveStatic } from '../harness/playwright/serve-and-visit.mjs';
import { installClipping } from './clipping.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');
/** --space-3, the least gap the stage text keeps from its button. */
const GAP = 8;

/** Opens one route in a fresh window of the given size; the caller closes the context. */
async function openPage(browser, origin, route, width, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await installClipping(context);
  const page = await context.newPage();
  await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  return { context, page };
}

/** Runs in the page: the boxes of the stage label's text lines and of the button in the row that offers to remove a copy. */
function measureDoneRow() {
  const btn = [...document.querySelectorAll('app-changes-table button')].find((b) => b.textContent.trim() === 'Remove the copy');
  if (!btn) return null;
  const cell = btn.closest('td');
  const label = cell.querySelector('.k-status');
  if (!label) return { missingLabel: true };
  const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  const range = document.createRange();
  range.selectNodeContents(label);
  const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map(box);
  return { button: box(btn.getBoundingClientRect()), label: box(label.getBoundingClientRect()), lines };
}

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function doneRow(browser, origin) {
  const fails = [];
  for (const width of [1280, 1600]) {
    const { context, page } = await openPage(browser, origin, 'sdlc', width);
    try {
      await page.locator('app-changes-table').first().waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: 'Remove the copy', exact: false }).first().waitFor({ timeout: 5000 });
      const m = await page.evaluate(measureDoneRow);
      const at = `the done row at ${width}`;
      if (!m || m.missingLabel) {
        fails.push(`${at}: no row with a stage label and a "Remove the copy" button`);
        continue;
      }
      if (overlaps(m.label, m.button)) fails.push(`${at}: the stage label overlaps the "Remove the copy" button`);
      else if (m.label.top < m.button.bottom && m.button.top < m.label.bottom) {
        const gap = m.button.left - m.label.right;
        if (gap < GAP) fails.push(`${at}: the gap between the stage label and the button is ${gap.toFixed(2)}px, under ${GAP}px`);
      }
    } finally {
      await context.close();
    }
  }
  const { context, page } = await openPage(browser, origin, 'sdlc', 1280);
  try {
    await page.locator('app-changes-table').first().waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Remove the copy', exact: false }).first().waitFor({ timeout: 5000 });
    await page.evaluate(() => {
      const pane = document.querySelector('app-changes-table').closest('.k-home__pane');
      pane.style.width = '420px';
      pane.style.flex = 'none';
    });
    await page.waitForTimeout(200);
    const m = await page.evaluate(measureDoneRow);
    const at = 'the done row with the changes pane at 420px';
    if (!m || m.missingLabel) fails.push(`${at}: no row with a stage label and a "Remove the copy" button`);
    else {
      for (const l of m.lines) {
        if (overlaps(l, m.button)) fails.push(`${at}: a line of the stage label (${l.left.toFixed(1)}-${l.right.toFixed(1)} by ${l.top.toFixed(1)}-${l.bottom.toFixed(1)}) lies inside the button's box`);
      }
    }
  } finally {
    await context.close();
  }
  return fails;
}

/** Runs in the page: the Finished list's box, the body's bottom inner edge and whether the list scrolls. */
function measureFinished() {
  const list = document.querySelector('.k-finished__list');
  if (!list) return null;
  const body = list.closest('.k-home__body');
  const bodyBox = body.getBoundingClientRect();
  const innerBottom = bodyBox.bottom - parseFloat(getComputedStyle(body).paddingBottom);
  return {
    listBottom: list.getBoundingClientRect().bottom,
    innerBottom,
    scrolls: list.scrollHeight > list.clientHeight,
    rows: list.querySelectorAll('[data-testid="finished-row"]').length,
  };
}

async function finished(browser, origin) {
  const fails = [];
  for (const [demo, many] of [['finished-many', true], ['finished-few', false]]) {
    const { context, page } = await openPage(browser, origin, `sdlc?demo=${demo}`, 1280, 900);
    try {
      await page.locator('app-finished-changes button[aria-expanded]').waitFor({ timeout: 5000 });
      await page.locator('app-finished-changes button[aria-expanded]').click();
      await page.locator('[data-testid="finished-row"]').first().waitFor({ timeout: 5000 });
      const m = await page.evaluate(measureFinished);
      const at = `the Finished list on ${demo}`;
      if (!m) {
        fails.push(`${at}: no list after opening the fold`);
        continue;
      }
      if (many) {
        if (Math.abs(m.listBottom - m.innerBottom) > 1) fails.push(`${at}: the list ends at ${m.listBottom.toFixed(1)}, not at the body's bottom inner edge ${m.innerBottom.toFixed(1)}`);
        if (!m.scrolls) fails.push(`${at}: the list does not scroll`);
      } else {
        if (m.rows !== 3) fails.push(`${at}: ${m.rows} rows show, not 3`);
        if (m.scrolls) fails.push(`${at}: the list scrolls`);
      }
    } finally {
      await context.close();
    }
  }
  return fails;
}

/** Part name to an async function (browser, origin) returning failure lines. */
export const PARTS = {
  'done-row': doneRow,
  finished,
};

/** Runs the named parts (all when `only` is empty or missing); returns the failures as readable lines. */
export async function checkSteadyLayouts(browser, origin, only) {
  const names = only && only.length ? only : Object.keys(PARTS);
  const unknown = names.filter((n) => !(n in PARTS));
  if (unknown.length) throw new Error(`unknown part ${unknown.join(', ')}; known parts: ${Object.keys(PARTS).join(', ')}`);
  const fails = [];
  for (const name of names) fails.push(...(await PARTS[name](browser, origin)).map((f) => `${name}: ${f}`));
  return fails;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--only');
  const only = i >= 0 ? (process.argv[i + 1] ?? '').split(',').filter(Boolean) : [];
  const unknown = only.filter((n) => !(n in PARTS));
  if (unknown.length) {
    process.stderr.write(`unknown part ${unknown.join(', ')}; known parts: ${Object.keys(PARTS).join(', ')}\n`);
    process.exit(1);
  }
  if (!existsSync(join(DIST, 'index.html'))) {
    process.stderr.write(`no production build at ${DIST}; run "npm run build" first\n`);
    process.exit(1);
  }
  const csp = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).app.security.csp;
  const srv = await serveStatic(DIST, { spaFallback: true, headers: { 'content-security-policy': csp } });
  const browser = await launchChromium();
  let fails;
  try {
    fails = await checkSteadyLayouts(browser, srv.origin, only);
  } finally {
    await browser.close();
    await srv.close();
  }
  if (fails.length) {
    process.stderr.write(`${fails.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`steady layouts passed (${(only.length ? only : Object.keys(PARTS)).join(', ')})\n`);
}
