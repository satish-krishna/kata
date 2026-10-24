// Desktop-only responsive gate. Kata is a desktop app (laptop to ultrawide, no mobile breakpoints), so jig's 375/768/1280 check is
// narrowed to 1280/1600, and the window's 1024 minimum is covered for the change page and the workspace home page.
// Builds, serves dist/angular-jig/browser statically, and asserts that no route scrolls the page horizontally or clips content at
// either width, then measures the change page's toolbar (real and long content), its Build strip and the home page in a real browser
// with the fractional clipping measure of scripts/clipping.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertResponsive } from '../harness/gate/check-responsive.mjs';
import { launchChromium, serveStatic } from '../harness/playwright/serve-and-visit.mjs';
import { checkDocLayoutLeft } from './check-doc-layout.mjs';
import { checkHomePage } from './check-home-page.mjs';
import { CHANGE_ROUTES, LONG_FIXTURES, STRIP_STATES, checkBuildStrip, checkChangeToolbar, checkPrPopover, checkStripHeight } from './check-change-toolbar.mjs';
import { formatCorrectiveMessage } from '../harness/gate/responsive-guidance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');
const BREAKPOINTS = [1280, 1600];
// The window has a minimum width of 1024, so the change page is measured there too.
const CHANGE_WIDTHS = [1024, 1280, 1600];
const STRIP_WIDTHS = [768, 1024, 1280, 1440];
const ROUTES = [
  { route: '', anchorSelector: 'app-workbench' },
  { route: 'library', anchorSelector: 'app-library' },
];

let failed = false;
// The desktop window opens wide enough for the toolbar and cannot be dragged narrower than the width the toolbar was measured at.
{
  const win = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).app.windows[0];
  const problems = [];
  if (!(win.width >= 1280)) problems.push(`width is ${win.width}, not at least 1280`);
  if (!(win.height >= 800)) problems.push(`height is ${win.height}, not at least 800`);
  if (win.minWidth !== 1280) problems.push(`minWidth is ${win.minWidth}, not 1280`);
  if (win.minHeight !== 800) problems.push(`minHeight is ${win.minHeight}, not 800`);
  if (problems.length) {
    process.stderr.write(`tauri.conf.json window: ${problems.join('; ')}\n`);
    failed = true;
  }
}
execFileSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true });
const srv = await serveStatic(DIST, { spaFallback: true });
try {
  for (const { route, anchorSelector } of ROUTES) {
    const { failures } = await assertResponsive({ origin: srv.origin, route, breakpoints: BREAKPOINTS, anchorSelector });
    if (failures.length) {
      process.stderr.write(`route "/${route}":\n${formatCorrectiveMessage(failures)}\n`);
      failed = true;
    }
  }
  // The change page's toolbar: pills, links, badge and name must fit side by side, not wrap or overlap, and long content must give way in the table's order.
  const browser = await launchChromium();
  try {
    for (const spec of [...CHANGE_ROUTES, ...LONG_FIXTURES]) {
      for (const width of CHANGE_WIDTHS) {
        const fails = await checkChangeToolbar(browser, srv.origin, spec, width);
        if (fails.length) {
          process.stderr.write(`${fails.map((f) => `route "/${spec.route}": ${f}`).join('\n')}\n`);
          failed = true;
        }
      }
    }
    // A finished change has no stage actions and its plan has a view toggle: the two ends of what the strip can hold. The Build strip wraps below 1280 and is then taller than the others, so the height is compared from 1280 up.
    for (const route of ['sdlc/claims/2026-10-18-photo-limits-shipped', 'sdlc/claims/2026-10-19-build-demo']) {
      for (const width of BREAKPOINTS) {
        const fails = await checkStripHeight(browser, srv.origin, route, width);
        if (fails.length) {
          process.stderr.write(`route "/${route}": ${fails.join('\n')}\n`);
          failed = true;
        }
      }
    }
    // The Build tab strip never cuts a control off, whatever the width.
    for (const state of STRIP_STATES) {
      for (const width of STRIP_WIDTHS) {
        const fails = await checkBuildStrip(browser, srv.origin, state, width);
        if (fails.length) {
          process.stderr.write(`route "/${state.route}": ${fails.join('\n')}\n`);
          failed = true;
        }
      }
    }
    // The workspace home page, down to the window's minimum width.
    for (const width of CHANGE_WIDTHS) {
      const fails = await checkHomePage(browser, srv.origin, width);
      if (fails.length) {
        process.stderr.write(`${fails.join('\n')}\n`);
        failed = true;
      }
    }
    // A document with no sections has no outline column, so its text starts at the left edge.
    for (const width of [1024, 1280]) {
      const fails = await checkDocLayoutLeft(browser, srv.origin, width);
      if (fails.length) {
        process.stderr.write(`${fails.join('\n')}\n`);
        failed = true;
      }
    }
    for (const width of CHANGE_WIDTHS) {
      const fails = await checkPrPopover(browser, srv.origin, width);
      if (fails.length) {
        process.stderr.write(`${fails.join('\n')}\n`);
        failed = true;
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await srv.close();
}
if (failed) process.exit(1);
process.stdout.write(`responsive check passed at ${BREAKPOINTS.join(', ')} (the change page and the home page at ${CHANGE_WIDTHS.join(', ')})\n`);
