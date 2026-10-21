// Desktop-only responsive gate. Kata is a desktop app (laptop to ultrawide, no
// mobile breakpoints), so jig's 375/768/1280 check is narrowed to 1280/1600.
// Builds, serves dist/angular-jig/browser statically, and asserts that neither
// route scrolls the page horizontally or clips content at either width.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertResponsive } from '../harness/gate/check-responsive.mjs';
import { launchChromium, serveStatic } from '../harness/playwright/serve-and-visit.mjs';
import { CHANGE_ROUTES, checkChangeToolbar } from './check-change-toolbar.mjs';
import { formatCorrectiveMessage } from '../harness/gate/responsive-guidance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');
const BREAKPOINTS = [1280, 1600];
const ROUTES = [
  { route: '', anchorSelector: 'app-workbench' },
  { route: 'library', anchorSelector: 'app-library' },
];

execFileSync('npm run build', { cwd: ROOT, stdio: 'inherit', shell: true });
const srv = await serveStatic(DIST, { spaFallback: true });
let failed = false;
try {
  for (const { route, anchorSelector } of ROUTES) {
    const { failures } = await assertResponsive({ origin: srv.origin, route, breakpoints: BREAKPOINTS, anchorSelector });
    if (failures.length) {
      process.stderr.write(`route "/${route}":\n${formatCorrectiveMessage(failures)}\n`);
      failed = true;
    }
  }
  // The change page's toolbar: pills, links, badge and name must fit side by side, not wrap or overlap.
  const browser = await launchChromium();
  try {
    for (const spec of CHANGE_ROUTES) {
      for (const width of BREAKPOINTS) {
        const fails = await checkChangeToolbar(browser, srv.origin, spec, width);
        if (fails.length) {
          process.stderr.write(`${fails.map((f) => `route "/${spec.route}": ${f}`).join('\n')}\n`);
          failed = true;
        }
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await srv.close();
}
if (failed) process.exit(1);
process.stdout.write(`responsive check passed at ${BREAKPOINTS.join(', ')}\n`);
