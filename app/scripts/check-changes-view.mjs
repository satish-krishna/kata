// The Changes view in a real browser (`npm run check:changes`; run `npm run build` first).
//
// Serves the production build under the desktop CSP and opens the Monaco diff editor on a
// modified file of the mock's scripted build. It proves what jsdom cannot:
//   1. CSP: no page error or console error, and the editor rendered with its stylesheet
//      applied (the `monaco` bundle is emitted unhashed and loaded against the document base).
//   2. Zoom: under Workbench zoom the original and modified panes stay aligned and the editor
//      fills its container.
//   3. Zoom keys: Ctrl +, - and 0 pressed inside the editor still reach the document, unhandled
//      by Monaco, with their default prevented by the app.
//   4. Widths: 375, 768 and 1280 pixels have no horizontal page scroll; the Changes view in the build page's files area
//      draws the one file list, and below 768 it sits above the diff
//      and the editor is inline.
//   5. Fit on the build page's files area (before a build starts), at 1280 and 1440 wide: the diff editor reaches the bottom of
//      the window, the view starts at the left edge of the files area with no frame of its own, and each repository header is one line.
//   6. The strip never cuts a control off: for a build-ready change and for a finished build with three actions and the pull request note,
//      at 768, 1024, 1280 and 1440 every control sits inside the strip and the strip inside the window, and at 1280 and up it is one row.
//   7. The Changes strip in the live build page's files area has no actions and wraps to at most two rows at 1024 and 1280 (4b in the code, run on the page that is inside the build).
import { STRIP_STATES, checkBuildStrip } from './check-change-toolbar.mjs';
import { MD, WIDTHS, eventually, noHorizontalScroll, open, reporter, startBuild } from './check-build-support.mjs';

const FILE = 'src/limits.rs';
const { check, done } = reporter('check:changes');
const FILES_AREA = '[data-area="files"]';
const { page, errors, close } = await open();

try {
  await startBuild(page);
  // The files area is tucked in the mode a running build opens on; Changes puts it in the middle.
  await page.keyboard.press('Control+3');
  await page.locator(`${FILES_AREA} [data-file="${FILE}"]`).click();
  const editor = page.locator('.monaco-diff-editor');
  await editor.waitFor({ state: 'visible' });
  await page.locator('.monaco-diff-editor .editor.modified .view-line').first().waitFor();

  // 1. CSP and stylesheet.
  const sheet = await page.evaluate(() => {
    const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => /(^|\/)monaco\.css$/.test(new URL(l.href).pathname));
    const rules = link?.sheet ? link.sheet.cssRules.length : 0;
    const lines = document.querySelector('.monaco-editor .view-lines');
    return { linked: !!link, rules, whiteSpace: lines ? getComputedStyle(lines).whiteSpace : null };
  });
  check(sheet.linked && sheet.rules > 0, `monaco.css loaded under the desktop CSP (${sheet.rules} rules)`);
  check(sheet.whiteSpace === 'nowrap', `the Monaco stylesheet is applied to the editor (view-lines white-space ${sheet.whiteSpace})`);
  check((await editor.innerText()).includes('limit'), 'the modified file text rendered in the editor');

  // 2. Zoom alignment, emulating Workbench zoom as the CSS viewport shrinking while the pixel ratio grows.
  const cdp = await page.context().newCDPSession(page);
  const geometry = () =>
    page.evaluate(() => {
      const topOf = (side) => {
        const lines = [...document.querySelectorAll(`.monaco-diff-editor .editor.${side} .view-line`)];
        return lines.length === 0 ? null : Math.min(...lines.map((l) => l.getBoundingClientRect().top));
      };
      const host = document.querySelector('.k-diff-editor__host').getBoundingClientRect();
      const diff = document.querySelector('.monaco-diff-editor').getBoundingClientRect();
      return { original: topOf('original'), modified: topOf('modified'), hostW: host.width, hostH: host.height, diffW: diff.width, diffH: diff.height };
    });
  const aligned = (g) =>
    g.original !== null && g.modified !== null && Math.abs(g.original - g.modified) <= 0.5 && Math.abs(g.hostW - g.diffW) <= 2 && Math.abs(g.hostH - g.diffH) <= 2;
  for (const [width, scale] of [[1280, 1], [640, 2], [1280, 1]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: scale, mobile: false });
    try {
      const g = await eventually(page, geometry, aligned, `zoom ${scale * 100}%`);
      check(true, `zoom ${scale * 100}% (${width} wide): panes aligned (top ${g.original} / ${g.modified}) and the editor fills its container (${g.diffW}x${g.diffH})`);
    } catch (e) {
      check(false, e.message);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // 3. Zoom keys reach the document from inside the editor, with the default prevented.
  await page.evaluate(() => {
    window.__keys = [];
    window.addEventListener('keydown', (e) => e.key !== 'Control' && window.__keys.push({ key: e.key, ctrl: e.ctrlKey, defaultPrevented: e.defaultPrevented }));
  });
  // The diff pane is a few dozen pixels wide at the default split, so a pointer click has no stable target; focus the editor's input directly.
  await page.evaluate(() => document.querySelector('.monaco-diff-editor .editor.modified textarea').focus());
  const insideEditor = await page.evaluate(() => !!document.activeElement?.closest('.editor.modified'));
  check(insideEditor, 'focus is inside the modified editor');
  for (const [combo, key] of [['Control+=', '='], ['Control+-', '-'], ['Control+0', '0']]) {
    await page.evaluate(() => (window.__keys = []));
    await page.keyboard.press(combo);
    const seen = await page.evaluate(() => window.__keys);
    check(seen.length === 1 && seen[0].key === key && seen[0].defaultPrevented === true, `${combo} inside the editor reached the document with defaultPrevented true (${JSON.stringify(seen)})`);
  }

  // 4. Widths.
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const state = await eventually(
      page,
      () =>
        page.evaluate(() => {
          const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
          const left = rect(`${'[data-area="files"]'} aside.k-changes__left`);
          const main = rect('.k-changes__main');
          const diff = document.querySelector('.monaco-diff-editor');
          const list = document.querySelector('[data-area="files"] aside.k-changes__left');
          return {
            listScroll: list ? list.scrollWidth - list.clientWidth : null,
            listAbove: left && main ? left.bottom <= main.top + 1 : null,
            listBeside: left && main ? left.right <= main.left + 1 : null,
            sideBySide: !!diff?.classList.contains('side-by-side'),
            ownList: document.querySelectorAll('[data-area="files"] aside.k-changes__left').length,
          };
        }),
      (s) => (width < MD ? s.listAbove === true && !s.sideBySide : s.listBeside === true),
      `layout at ${width}`,
    ).catch((e) => ({ error: e.message }));
    const scroll = await noHorizontalScroll(page);
    check(scroll.scrollWidth <= scroll.clientWidth && scroll.body <= scroll.clientWidth, `${width}px: no horizontal page scroll (${scroll.scrollWidth} of ${scroll.clientWidth})`);
    if (state.error) check(false, state.error);
    else {
      check(state.listScroll !== null && state.listScroll <= 0, `${width}px: the file list does not scroll sideways (scrollWidth - clientWidth = ${state.listScroll})`);
      check(state.ownList === 1, `${width}px: the build page's files area draws the Changes view's one file list (${state.ownList})`);
    }
    if (!state.error && width < MD) check(true, `${width}px: the list is above the diff and the editor is inline`);
    else if (!state.error) check(true, `${width}px: the list sits beside the diff`);
  }

  // 4b. The Changes strip in the live build page's files area has no actions, but the files area is a third of the window at the default split, so its controls do not fit one row at the window's minimum width (1024) or its opening width (1280): it wraps to at most two rows and check:build proves none is cut off.
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    const row = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="changes-strip"]');
      const kids = [...strip.children, ...strip.querySelectorAll('.k-changes__end > *')].filter((el) => el.getBoundingClientRect().width > 0);
      const mids = kids.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
      return { rows: new Set(mids.map((m) => Math.round(m / 8))).size, count: kids.length, slotted: strip.querySelectorAll('.k-changes__end > :not(.k-changes__note)').length };
    });
    check(row.count > 0 && row.slotted === 0 && row.rows <= 2, `${width}x900: the Changes strip in the live build page's files area is at most two rows (${row.count} items, ${row.slotted} slotted, ${row.rows} rows)`);
  }

  check(errors.length === 0, `no page error, console error or failed request${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await close();
}

// 5. Fit on the change page's Build tab. A second page, because the first one is inside a live build.
{
  const fit = await open({ width: 1440, height: 900 });
  try {
    await fit.page.getByRole('tab', { name: /^Build/ }).click();
    // Before a build the page opens on Overview, which tucks the files; Changes puts them in the middle.
    await fit.page.keyboard.press('Control+3');
    await fit.page.locator('[data-testid="changes-strip"]').waitFor();
    await fit.page.locator(`[data-file="${FILE}"]`).first().click();
    await fit.page.locator('.monaco-diff-editor .editor.modified .view-line').first().waitFor();
    for (const width of [1280, 1440]) {
      await fit.page.setViewportSize({ width, height: 900 });
      await fit.page.waitForTimeout(300);
      const m = await fit.page.evaluate(() => {
        const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
        const root = document.querySelector('app-changes-view .k-changes');
        const sides = ['Top', 'Right', 'Bottom', 'Left'];
        // The view and every box between it and its tab panel (the panel included): any of them can frame the view.
        const frame = [];
        for (let el = root; el; el = el.parentElement) {
          frame.push(el);
          if (el.getAttribute('role') === 'tabpanel') break;
        }
        const file = box('[data-file]');
        // A header is one line when its branch sits at the height of its name and its own text sits on a single line (a truncated text can have two boxes on that line).
        const wraps = (head) => {
          const branch = head.querySelector('[data-branch]');
          const range = document.createRange();
          range.selectNodeContents(branch);
          return new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top))).size > 1 || Math.abs(branch.getBoundingClientRect().top - head.querySelector('.k-files__name').getBoundingClientRect().top) > 2;
        };
        return {
          viewportH: window.innerHeight,
          areaBottom: box('[data-area="files"]')?.bottom,
          editorBottom: box('app-changes-view app-diff-editor')?.bottom,
          padding: frame.flatMap((el) => sides.map((s) => parseFloat(getComputedStyle(el)['padding' + s]))),
          border: frame.flatMap((el) => sides.map((s) => parseFloat(getComputedStyle(el)['border' + s + 'Width']))),
          frameDepth: frame.length,
          rootLeft: root.getBoundingClientRect().left,
          stripLeft: box('[data-area="files"]')?.left,
          strips: document.querySelectorAll('[data-testid="strip"], [data-testid="changes-strip"]').length,
          listScroll: document.querySelector('aside.k-changes__left').scrollWidth - document.querySelector('aside.k-changes__left').clientWidth,
          fileH: file.height,
          stripRow: (() => {
            const strip = document.querySelector('[data-testid="changes-strip"]');
            const kids = [...strip.children, ...strip.querySelectorAll('.k-changes__end > *')].filter((el) => el.getBoundingClientRect().width > 0);
            const mids = kids.map((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; });
            return { spread: Math.max(...mids) - Math.min(...mids), count: kids.length };
          })(),
          repoName: (() => {
            const el = [...document.querySelectorAll('[data-repo] .k-files__name')].find((n) => n.textContent.trim() === 'commerce-docs');
            if (!el) return null;
            return window.kataClip.textClipped(el);
          })(),
          repos: [...document.querySelectorAll('[data-repo]')].map((r) => ({ h: r.getBoundingClientRect().height, wraps: wraps(r) })),
        };
      });
      // The reference is the bottom of the files area: the Build tab fills the page, which never scrolls (the editor scrolls itself),
      // so a diff that ends short of its area is wasted height whichever box contains it. The area itself ends where the mode's other areas begin.
      check(Math.abs(m.areaBottom - m.editorBottom) <= 4 && m.areaBottom <= m.viewportH, `${width}x900: the diff editor reaches the bottom of the files area (editor bottom ${m.editorBottom}, area bottom ${m.areaBottom} of ${m.viewportH})`);
      check(m.padding.every((p) => p === 0) && m.border.every((b) => b === 0), `${width}x900: the Changes view has no padding or border (${m.frameDepth} boxes; padding ${m.padding}, border ${m.border})`);
      check(Math.abs(m.rootLeft - m.stripLeft) <= 1, `${width}x900: the Changes view starts at the left edge of the files area (${m.rootLeft} / ${m.stripLeft})`);
      check(m.listScroll <= 0, `${width}x900: the file list does not scroll sideways (scrollWidth - clientWidth = ${m.listScroll})`);
      check(m.stripRow.count > 0 && m.stripRow.spread <= 4, `${width}x900: the Changes strip is a single row (${m.stripRow.count} items, vertical centers ${m.stripRow.spread}px apart)`);
      if (width === 1280) check(m.repoName !== null && m.repoName <= 0, `${width}x900: the commerce-docs group name is not truncated (${m.repoName}px of it is cut off)`);
      check(m.strips === 1, `${width}x900: the Build tab has exactly one strip (${m.strips})`);
      check(m.repos.length > 0 && m.repos.every((r) => r.h <= m.fileH * 1.5), `${width}x900: every repository header is at most 1.5 file rows tall (file row ${m.fileH}; headers ${m.repos.map((r) => r.h)})`);
      check(m.repos.every((r) => !r.wraps), `${width}x900: no repository header wraps its branch (${m.repos.map((r) => r.wraps)})`);
    }
  } finally {
    await fit.close();
  }
}
// 6. The strip, in the two states that carry the most: build-ready, and finished with three actions and the note.
{
  const strip = await open();
  try {
    for (const state of STRIP_STATES) {
      for (const width of [768, 1024, 1280, 1440]) {
        const fails = await checkBuildStrip(strip.browser, strip.origin, state, width);
        check(fails.length === 0, `${state.name} at ${width}: nothing in the strip is cut off${fails.length ? `: ${fails.join(' | ')}` : ''}`);
      }
    }
  } finally {
    await strip.close();
  }
}
done();
