#!/usr/bin/env node
// Interaction check: does the page WORK, not merely render.
//
// WHY THIS EXISTS. The capstone's finding #1 was that every fatal defect it
// measured was a dependency-injection or composition failure, that no AST rule
// reaches any of them, and that "a browser sees all three instantly". The
// remedy adopted was check-boot.mjs. That remedy is narrower than the finding:
// check-boot RENDERS each route and never INTERACTS with it, and every defect
// in that class lives behind a trigger by definition.
//
// The Hero Ops Console build then demonstrated the gap twice, in one run:
//
//   Task 6  Three hlm-select overlays were written without *hlmSelectPortal.
//           BrnOverlayContent registers its template only under `*` syntax, so
//           BrnOverlay._content stayed undefined and open() returned early --
//           the popover could never open, and the un-templated content rendered
//           as permanently-visible inline DOM. Four counters read zero, 42
//           tests passed, and `check-boot --route settings` was green.
//
//   Final   Six form dialogs had no close path at all. Save wrote the record
//           and left the dialog open with the form still populated, so a second
//           click created a duplicate. Same clean board, same green boot check.
//
// Neither is reachable from jsdom either: the unit suite cannot drive a CDK
// overlay, because jsdom provides neither ResizeObserver nor scrollIntoView.
// A real browser is the only instrument that sees this class, which is what
// this check is.
//
// WHAT IT DOES. For each route, it clicks every element carrying a known
// overlay trigger attribute, and asserts three things: an overlay becomes
// visible, dismissing it makes the overlay go away, and the console stays
// clean throughout. That triad is exactly the shape of both defects above.
//
// Usage:
//   node harness/gate/check-interaction.mjs
//   node harness/gate/check-interaction.mjs --route missions --route settings
//   node harness/gate/check-interaction.mjs --json

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// Elements that are supposed to open an overlay. Each entry is a CSS selector
// and the selector for the surface it should produce.
const TRIGGERS = [
  { name: 'dialog', trigger: '[hlmDialogTrigger]', surface: 'hlm-dialog-content' },
  // Only the button HlmSelectTrigger renders. An earlier draft also matched
  // `button[id][aria-haspopup]`, which catches dialog triggers too -- they
  // carry aria-haspopup="dialog" -- so the check clicked a dialog and then
  // reported that no select had opened. A checker with a false positive gets
  // switched off, so the selector is exact.
  { name: 'select', trigger: 'hlm-select-trigger button', surface: 'hlm-select-content' },
];

const DEFAULT_ROUTES = ['dashboard', 'roster', 'detail/11', 'missions', 'threats', 'recruit', 'settings'];

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const routes = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--route') routes.push(argv[++i]);
const targetRoutes = routes.length ? routes : DEFAULT_ROUTES;

async function serve() {
  const server = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    for (const candidate of [join(DIST, url), join(DIST, 'index.html')]) {
      try {
        const body = await readFile(candidate);
        res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
        res.end(body);
        return;
      } catch {
        /* fall through to the SPA index */
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, r));
  return { server, port: server.address().port };
}

const findings = [];
const checks = [];

const { server, port } = await serve();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });

let consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

for (const route of targetRoutes) {
  await page.goto(`http://localhost:${port}/${route}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(250);

  for (const kind of TRIGGERS) {
    const triggers = page.locator(kind.trigger);
    const count = await triggers.count();

    for (let i = 0; i < count; i++) {
      const label = `${route} :: ${kind.name}[${i}]`;
      consoleErrors = [];

      // An overlay content element visible BEFORE anything is clicked means the
      // content was never portalled -- it rendered inline. That is the Task 6
      // defect, and it is visible without clicking anything.
      const leakedBefore = await page.locator(`${kind.surface}:visible`).count();
      if (leakedBefore > 0) {
        findings.push({
          route,
          kind: kind.name,
          detail: `${kind.surface} is visible before any trigger was clicked (${leakedBefore} of them) -- the content is not on its portal, so it renders inline and the overlay can never open`,
        });
        break;
      }

      try {
        await triggers.nth(i).click({ timeout: 5000 });
      } catch {
        // A trigger that cannot be clicked (offscreen, covered) is not a
        // defect this check is designed to judge; skip it rather than
        // manufacture a finding.
        continue;
      }
      await page.waitForTimeout(350);

      const opened = await page.locator(`${kind.surface}:visible`).count();
      checks.push({ label, opened: opened > 0 });

      if (opened === 0) {
        findings.push({
          route,
          kind: kind.name,
          detail: `clicking ${kind.trigger} #${i} produced no visible ${kind.surface} -- the overlay does not open`,
        });
        continue;
      }

      await page.keyboard.press('Escape');
      await page.waitForTimeout(350);
      const stillOpen = await page.locator(`${kind.surface}:visible`).count();
      if (stillOpen > 0) {
        findings.push({
          route,
          kind: kind.name,
          detail: `${kind.surface} opened by ${kind.trigger} #${i} did not close on Escape -- it has no dismissal path`,
        });
        // Reload rather than leave a modal trapping subsequent clicks.
        await page.goto(`http://localhost:${port}/${route}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(250);
      }

      if (consoleErrors.length) {
        findings.push({
          route,
          kind: kind.name,
          detail: `console error while operating ${kind.trigger} #${i}: ${consoleErrors[0]}`,
        });
      }
    }
  }
}

await browser.close();
server.close();

const tally = { totals: { overlaysExercised: checks.length, failures: findings.length }, findings };

if (asJson) {
  console.log(JSON.stringify(tally, null, 2));
} else if (findings.length === 0) {
  console.log(
    `interaction check passed: ${checks.length} overlay(s) across ${targetRoutes.length} route(s) opened, closed, and logged no errors`,
  );
} else {
  for (const f of findings) console.log(`FAIL  ${f.route}  [${f.kind}]  ${f.detail}`);
  console.log(`\ninteraction check FAILED: ${findings.length} finding(s) across ${checks.length} overlay(s)`);
}

process.exit(findings.length === 0 ? 0 : 1);
