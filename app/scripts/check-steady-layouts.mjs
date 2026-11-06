// Steady layouts: places on the AI-SDLC pages where two things that sit side by side must keep a gap, or wrap instead of overlapping.
// Each part opens its own page(s) from `browser` and `origin` and returns its failures as readable lines. Run one or more directly
// with `node scripts/check-steady-layouts.mjs --only done-row` (after `npm run build`); `check:responsive` runs every part.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, serveStatic } from '../harness/playwright/serve-and-visit.mjs';
import { installClipping } from './clipping.mjs';
import { ROUTE, startBuild } from './check-build-support.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');
/** --space-3, the least gap the stage text keeps from its button. */
const GAP = 8;

/** Opens one route in a fresh window of the given size; the caller closes the context. */
async function openPage(browser, origin, route, width, height = 900, waitUntil = 'networkidle') {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await installClipping(context);
  const page = await context.newPage();
  await page.goto(`${origin}/${route}`, { waitUntil });
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


/** Runs in the page: every change row's box, and the progress line's box with the Changes heading's. */
function measureRefresh() {
  const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  const rows = [...document.querySelectorAll('app-changes-table tbody tr')].map((r) => box(r.getBoundingClientRect()));
  const progress = document.querySelector('[data-testid="reading-progress"]');
  const head = document.querySelector('#changes-heading')?.closest('.wb-pane__head');
  return {
    rows,
    progress: progress ? box(progress.getBoundingClientRect()) : null,
    text: progress ? progress.textContent.replace(/\s+/g, ' ').trim() : '',
    head: head ? box(head.getBoundingClientRect()) : null,
    pane: head?.parentElement ? box(head.parentElement.getBoundingClientRect()) : null,
    next: head?.parentElement?.nextElementSibling ? box(head.parentElement.nextElementSibling.getBoundingClientRect()) : null,
    wrapped: progress ? progress.getClientRects().length > 1 || progress.scrollWidth > progress.clientWidth : false,
  };
}

const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;

/** Compares the rows with the ones recorded before the refresh; returns failure lines. */
/** With `filled`, the rows' own heights may change (skeletons give way to the stage labels), so only the rows down to the first such change are compared. */
function sameRows(at, before, now, filled = false) {
  if (now.rows.length !== before.length) return [`${at}: ${now.rows.length} rows, not ${before.length}`];
  const fails = [];
  let stop = false;
  now.rows.forEach((r, i) => {
    if (stop) return;
    if (filled && Math.abs(r.bottom - r.top - (before[i].bottom - before[i].top)) > 0.5) stop = true;
    for (const k of stop ? ['top', 'left'] : ['top', 'left', 'bottom', 'right']) {
      if (Math.abs(r[k] - before[i][k]) > 0.5) fails.push(`${at}: row ${i + 1} moved (${k} ${before[i][k].toFixed(1)} to ${r[k].toFixed(1)})`);
    }
  });
  return fails.slice(0, 3);
}

/** While the progress shows and after it hides, the rows stay where they were and the progress sits in the heading. */
async function watchRefresh(page, before, at, wantLong, filled = false, inPane = false) {
  const fails = [];
  const progress = page.locator('[data-testid="reading-progress"]');
  await progress.waitFor({ state: 'visible', timeout: 8000 });
  if (wantLong) await page.waitForFunction(() => /longer than usual/.test(document.querySelector('[data-testid="reading-progress"]')?.textContent ?? ''), null, { timeout: 25000 });
  const m = await page.evaluate(measureRefresh);
  if (!m.progress || !m.head) return [`${at}: no progress or no Changes heading`];
  if (!inside(m.progress, m.head)) fails.push(`${at}: the progress is not inside the Changes heading`);
  if (m.rows.some((r) => overlaps(r, m.progress))) fails.push(`${at}: the progress overlaps a row`);
  if (inPane) {
    if (!m.pane) fails.push(`${at}: no Changes pane`);
    else {
      if (m.progress.right > m.pane.right + 0.5) fails.push(`${at}: the progress runs past the Changes pane (right ${m.progress.right.toFixed(1)} over ${m.pane.right.toFixed(1)})`);
      if (m.next && m.progress.right > m.next.left + 0.5) fails.push(`${at}: the progress runs into the next pane (right ${m.progress.right.toFixed(1)} over ${m.next.left.toFixed(1)})`);
    }
  }
  if (m.wrapped) fails.push(`${at}: the progress text wraps or is cut`);
  if (wantLong && !/longer than usual/.test(m.text)) fails.push(`${at}: the long notice does not show`);
  fails.push(...sameRows(`${at}, while it shows`, before, m));
  await progress.waitFor({ state: 'hidden', timeout: 25000 });
  await page.waitForTimeout(200);
  fails.push(...sameRows(`${at}, after it hides`, before, await page.evaluate(measureRefresh), filled));
  return fails;
}

async function refresh(browser, origin) {
  const fails = [];
  for (const [long, three] of [[false, false], [true, false], [true, true]]) {
    const { context, page } = await openPage(browser, origin, `sdlc?demo=slow-read${long ? '&long=1' : ''}${three ? '&systems=3' : ''}`, 1280, 900, 'domcontentloaded');
    try {
      await page.locator('app-changes-table tbody tr').first().waitFor({ timeout: 5000 });
      await page.locator('app-changes-table tbody tr').first().hover();
      const first = await page.evaluate(measureRefresh);
      if (first.progress) {
        fails.push('the progress already showed before the rows were recorded; the check cannot compare');
        continue;
      }
      const at = three ? 'the long refresh on load with three systems' : long ? 'the long refresh on load' : 'the refresh on load';
      if (three) {
        const segs = await page.locator('#changes-heading ~ app-segmented button').count();
        if (segs < 3) fails.push(`${at}: the system picker has ${segs} segments, not 3`);
      }
      fails.push(...(await watchRefresh(page, first.rows, at, long, true, three)));
      if (long) continue;
      const settled = await page.evaluate(measureRefresh);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('focus'));
      });
      fails.push(...(await watchRefresh(page, settled.rows, 'the refresh on focus', false)));
    } finally {
      await context.close();
    }
  }
  return fails;
}

/** Runs in the page: the heights of the panes on show in the Activity area (there must be exactly one), and the session tabs with their boxes. */
function measureSessions() {
  const panes = [...document.querySelectorAll('[data-area="activity"] [data-session]:not([hidden]) [data-pane]:not([hidden])')];
  const row = document.querySelector('[data-area="activity"] [data-session-tabs]');
  const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  return {
    panes: panes.map((p) => p.getBoundingClientRect().height),
    row: row ? box(row.getBoundingClientRect()) : null,
    tabs: row ? [...row.querySelectorAll('[data-session-tab]')].map((t) => ({ text: t.textContent.replace(/\s+/g, ' ').trim(), selected: t.getAttribute('aria-selected'), box: box(t.getBoundingClientRect()) })) : [],
  };
}

/** Opens the build page of the sessions demo with `earlier` earlier sessions, and starts the build so the repository's session is running. */
async function openSessions(browser, origin, earlier) {
  const { context, page } = await openPage(browser, origin, `${ROUTE.slice(1)}?demo=sessions&earlier=${earlier}`, 1280, 800);
  await startBuild(page);
  await page.locator('[data-area="activity"] [data-session]:not([hidden]) [data-pane]:not([hidden])').first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  return { context, page };
}

const ENDINGS = ['finished', 'failed', 'cancelled', 'out of time', 'nobody answered'];

/** Heights of the pane on show for 0, 1, 6 and 8 earlier sessions: all equal within a pixel. */
async function sameHeights(browser, origin) {
  const heights = {};
  const fails = [];
  for (const n of [0, 1, 6, 8]) {
    const { context, page } = await openSessions(browser, origin, n);
    try {
      const m = await page.evaluate(measureSessions);
      if (m.panes.length !== 1) fails.push(`${n} earlier: ${m.panes.length} panes on show, not 1`);
      else heights[n] = m.panes[0];
    } finally {
      await context.close();
    }
  }
  const values = Object.values(heights);
  if (values.length && Math.max(...values) - Math.min(...values) > 1) {
    fails.push(`the running pane is not the same height for 0, 1, 6 and 8 earlier sessions (${Object.entries(heights).map(([n, h]) => `${n}: ${h.toFixed(1)}`).join(', ')})`);
  }
  return fails;
}

/** With 5 earlier sessions: each earlier tab says how it ended, and picking it shows its pane as tall as the running pane was. */
async function endings(browser, origin) {
  const fails = [];
  const { context, page } = await openSessions(browser, origin, 5);
  try {
    const running = (await page.evaluate(measureSessions)).panes[0];
    const tabs = page.locator('[data-area="activity"] [data-session-tab]');
    const count = await tabs.count();
    if (count !== 6) return [`${count} tabs, not 6`];
    const text = (await page.evaluate(measureSessions)).tabs.map((t) => t.text);
    if (!/running/i.test(text[0])) fails.push(`the first tab does not say running (${text[0]})`);
    // Newest first: the earlier sessions follow the running one, the newest of them first (the last one made is the fifth ending).
    for (let i = 1; i < count; i++) {
      const want = ENDINGS[5 - i];
      if (!text[i].includes(want)) fails.push(`tab ${i + 1} does not say "${want}" (${text[i]})`);
      await tabs.nth(i).click();
      await page.waitForTimeout(150);
      const m = await page.evaluate(measureSessions);
      if (m.panes.length !== 1 || Math.abs(m.panes[0] - running) > 1) fails.push(`picking the "${want}" tab shows ${m.panes.length} panes of heights ${m.panes.join(', ')}, not one of ${running.toFixed(1)}`);
      if (m.tabs[i].selected !== 'true') fails.push(`the "${want}" tab is not selected after it was picked`);
    }
  } finally {
    await context.close();
  }
  return fails;
}

/** With 8 earlier sessions: the running tab shows on load, and scrolling the row brings every tab into view. */
async function reach(browser, origin) {
  const fails = [];
  const { context, page } = await openSessions(browser, origin, 8);
  try {
    const m = await page.evaluate(measureSessions);
    if (m.tabs.length !== 9) return [`${m.tabs.length} tabs, not 9`];
    if (!inside(m.tabs[0].box, m.row)) fails.push('the running tab is not inside the tab row on load');
    const seen = new Set();
    const steps = await page.evaluate(async () => {
      const row = document.querySelector('[data-area="activity"] [data-session-tabs]');
      const out = [];
      const tabs = () => [...row.querySelectorAll('[data-session-tab]')];
      const mark = () => {
        const r = row.getBoundingClientRect();
        out.push(tabs().map((t) => { const b = t.getBoundingClientRect(); return b.left >= r.left - 0.5 && b.right <= r.right + 0.5; }));
      };
      for (let x = 0; ; x += Math.max(1, row.clientWidth / 2)) {
        row.scrollLeft = x;
        await new Promise((res) => requestAnimationFrame(res));
        mark();
        if (x >= row.scrollWidth) break;
      }
      return out;
    });
    for (const step of steps) step.forEach((on, i) => on && seen.add(i));
    const missed = [...Array(9).keys()].filter((i) => !seen.has(i));
    if (missed.length) fails.push(`scrolling the row never brought tab(s) ${missed.map((i) => i + 1).join(', ')} fully into view`);
  } finally {
    await context.close();
  }
  return fails;
}

async function sessions(browser, origin) {
  return [...(await sameHeights(browser, origin)), ...(await endings(browser, origin)), ...(await reach(browser, origin))];
}

/** Runs in the page: every task row of the Tasks area with the boxes of its id, name, status, commits and second row. */
function measureTasks() {
  const box = (r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height });
  const rows = [];
  for (const ul of document.querySelectorAll('[data-area="tasks"] .k-bp__tasks')) {
    [...ul.children].forEach((li, i) => {
      const btn = li.querySelector('[data-task]');
      const name = btn.querySelector('.k-bp__task-name');
      const lineHeight = parseFloat(getComputedStyle(name).lineHeight) || 0;
      const commits = btn.querySelector('[data-commits]');
      rows.push({
        id: btn.querySelector('.k-mono').textContent.trim(),
        first: i === 0,
        border: parseFloat(getComputedStyle(li).borderTopWidth),
        idBox: box(btn.querySelector('.k-mono').getBoundingClientRect()),
        nameBox: box(name.getBoundingClientRect()),
        wraps: lineHeight > 0 && name.getBoundingClientRect().height > lineHeight * 1.5,
        status: box(btn.querySelector('.k-status').getBoundingClientRect()),
        commits: commits ? box(commits.getBoundingClientRect()) : null,
        meta: btn.querySelector('[data-task-meta]') !== null,
        departed: btn.querySelector('[data-departure]') !== null,
      });
    });
  }
  return rows;
}

/** Opens every fold of the Tasks area so the finished rows show too, and returns the rows measured. */
async function openedTaskRows(page) {
  await page.locator('[data-area="tasks"] [data-fold], [data-area="tasks"] [data-task]').first().waitFor({ timeout: 8000 });
  const closed = page.locator('[data-area="tasks"] [data-fold][aria-expanded="false"]');
  while ((await closed.count()) > 0) await closed.first().click();
  await page.waitForTimeout(300);
  return page.evaluate(measureTasks);
}

/** The Tasks area on the long build: rows set apart by a hairline, and the id and status in the same place on every row. */
async function tasks(browser, origin) {
  const fails = [];
  const all = [];
  const compare = (at, rows) => {
    if (rows.length < 3) fails.push(`${at}: ${rows.length} task rows, too few to compare`);
    for (const r of rows) {
      if (!r.first && Math.abs(r.border - 1) > 0.01) fails.push(`${at}: task ${r.id} has a top border of ${r.border}px, not 1px`);
      if (Math.abs(r.idBox.left - rows[0].idBox.left) > 0.5) fails.push(`${at}: task ${r.id}: its id starts at ${r.idBox.left.toFixed(1)}, not ${rows[0].idBox.left.toFixed(1)}`);
      if (Math.abs(r.status.right - rows[0].status.right) > 0.5) fails.push(`${at}: task ${r.id}: its status ends at ${r.status.right.toFixed(1)}, not ${rows[0].status.right.toFixed(1)}`);
      if (r.commits && r.commits.top < r.nameBox.bottom - 0.5) fails.push(`${at}: task ${r.id}: its commits start at ${r.commits.top.toFixed(1)}, above the end of its name at ${r.nameBox.bottom.toFixed(1)}`);
      if (r.meta !== Boolean(r.commits || r.departed)) fails.push(`${at}: task ${r.id} ${r.meta ? 'has a second row but no commits or departure' : 'has commits or a departure but no second row'}`);
    }
    all.push(...rows);
  };
  // A finished change: every task has its commits.
  {
    const { context, page } = await openPage(browser, origin, 'sdlc/commerce/2026-10-18-photo-limits-shipped?demo=build-long', 1280, 800);
    try {
      compare('the finished change', await openedTaskRows(page));
    } finally {
      await context.close();
    }
  }
  // A running build: open tasks without commits, and finished ones with a departure.
  {
    const { context, page } = await openPage(browser, origin, `${ROUTE.slice(1)}?demo=build-long`, 1280, 800);
    try {
      await startBuild(page);
      await page.locator('[data-area="tasks"] [data-fold]').first().waitFor({ timeout: 20000 }).catch(() => {});
      compare('the running build', await openedTaskRows(page));
    } finally {
      await context.close();
    }
  }
  if (!all.some((r) => r.wraps)) fails.push('no task name wraps at 1280, so the check cannot show a long name keeps the status in place');
  if (!all.some((r) => r.commits)) fails.push('no task shows commits, so the second row is not checked');
  if (!all.some((r) => !r.commits && !r.departed)) fails.push('every task has commits or a departure, so the missing second row is not checked');
  return fails.slice(0, 40);
}

/** Part name to an async function (browser, origin) returning failure lines. */
export const PARTS = {
  'done-row': doneRow,
  finished,
  refresh,
  sessions,
  tasks,
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
