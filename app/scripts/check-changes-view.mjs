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
//   4. Widths: 375, 768 and 1280 pixels have no horizontal page scroll; below 768 the file list
//      sits above the diff and the editor is inline.
//   5. Fit on the change page's Build tab (before a build starts), at 1280 and 1440 wide: the diff editor reaches the bottom of
//      the window, the view sits flush under the tab strip with no frame of its own, and each repository header is one line.
import { MD, WIDTHS, eventually, noHorizontalScroll, open, reporter, startBuild } from './check-build-support.mjs';

const FILE = 'src/limits.rs';
const { check, done } = reporter('check:changes');
const { page, errors, close } = await open();

try {
  await startBuild(page);
  await page.getByRole('tab', { name: 'Changes' }).click();
  await page.locator(`[data-file="${FILE}"]`).click();
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
  await page.locator('.monaco-diff-editor .editor.modified .view-lines').click();
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
          const left = rect('.k-changes__left');
          const main = rect('.k-changes__main');
          const diff = document.querySelector('.monaco-diff-editor');
          const aside = document.querySelector('aside.k-changes__left');
          return { listScroll: aside ? aside.scrollWidth - aside.clientWidth : null, listAbove: left && main ? left.bottom <= main.top + 1 : null, listBeside: left && main ? left.right <= main.left + 1 : null, sideBySide: !!diff?.classList.contains('side-by-side') };
        }),
      (s) => (width < MD ? s.listAbove === true && !s.sideBySide : s.listBeside === true),
      `layout at ${width}`,
    ).catch((e) => ({ error: e.message }));
    const scroll = await noHorizontalScroll(page);
    check(scroll.scrollWidth <= scroll.clientWidth && scroll.body <= scroll.clientWidth, `${width}px: no horizontal page scroll (${scroll.scrollWidth} of ${scroll.clientWidth})`);
    if (state.error) check(false, state.error);
    else check(state.listScroll !== null && state.listScroll <= 0, `${width}px: the file list does not scroll sideways (scrollWidth - clientWidth = ${state.listScroll})`);
    if (!state.error && width < MD) check(true, `${width}px: the list is above the diff and the editor is inline`);
    else if (!state.error) check(true, `${width}px: the list sits beside the diff`);
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
        // A header is one line when its branch sits at the height of its name and its own text is a single line box.
        const wraps = (head) => {
          const branch = head.querySelector('[data-branch]');
          const range = document.createRange();
          range.selectNodeContents(branch);
          return range.getClientRects().length > 1 || Math.abs(branch.getBoundingClientRect().top - head.querySelector('.k-files__name').getBoundingClientRect().top) > 2;
        };
        return {
          viewportH: window.innerHeight,
          editorBottom: box('app-changes-view app-diff-editor')?.bottom,
          padding: frame.flatMap((el) => sides.map((s) => parseFloat(getComputedStyle(el)['padding' + s]))),
          border: frame.flatMap((el) => sides.map((s) => parseFloat(getComputedStyle(el)['border' + s + 'Width']))),
          frameDepth: frame.length,
          rootLeft: root.getBoundingClientRect().left,
          stripLeft: box('app-sdlc-toolbar header')?.left,
          strips: document.querySelectorAll('[data-testid="strip"], [data-testid="changes-strip"]').length,
          listScroll: document.querySelector('aside.k-changes__left').scrollWidth - document.querySelector('aside.k-changes__left').clientWidth,
          fileH: file.height,
          repos: [...document.querySelectorAll('[data-repo]')].map((r) => ({ h: r.getBoundingClientRect().height, wraps: wraps(r) })),
        };
      });
      // The reference is the bottom of the window: the Build tab fills the page, which never scrolls (the editor scrolls itself),
      // so a diff that ends short of the window bottom is wasted height whichever box contains it.
      check(Math.abs(m.viewportH - m.editorBottom) <= 4, `${width}x900: the diff editor reaches the bottom of the window (editor bottom ${m.editorBottom} of ${m.viewportH})`);
      check(m.padding.every((p) => p === 0) && m.border.every((b) => b === 0), `${width}x900: the Changes view has no padding or border (${m.frameDepth} boxes; padding ${m.padding}, border ${m.border})`);
      check(Math.abs(m.rootLeft - m.stripLeft) <= 1, `${width}x900: the Changes view lines up with the tab strip (${m.rootLeft} / ${m.stripLeft})`);
      check(m.listScroll <= 0, `${width}x900: the file list does not scroll sideways (scrollWidth - clientWidth = ${m.listScroll})`);
      check(m.strips === 1, `${width}x900: the Build tab has exactly one strip (${m.strips})`);
      check(m.repos.length > 0 && m.repos.every((r) => r.h <= m.fileH * 1.5), `${width}x900: every repository header is at most 1.5 file rows tall (file row ${m.fileH}; headers ${m.repos.map((r) => r.h)})`);
      check(m.repos.every((r) => !r.wraps), `${width}x900: no repository header wraps its branch (${m.repos.map((r) => r.wraps)})`);
    }
  } finally {
    await fit.close();
  }
}
done();
