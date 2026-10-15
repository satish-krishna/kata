// The boot gate (`npm run check:boot`).
//
// Renders every route and fails on an uncaught runtime error. This is the plane
// the capstone showed was missing, and it is aimed at a family rather than a
// rule: three of the four genuinely fatal defects that run produced were
// dependency-injection failures, and no AST rule reached any of them.
//
//   - `NgIconsModule` imported with no root-level `provideIcons`: throws at
//     bootstrap, blank page, three of six builds.
//   - A component-scoped ViewModel injected but never provided: NullInjectorError
//     on first render.
//   - `hlm-dialog-content` rendered inline instead of on `*hlmDialogPortal`:
//     spartan supplies `BrnDialogRef` through the portal, so inline content has
//     no provider and the screen throws NG0201 when the dialog is constructed.
//
// Every one of those compiles cleanly, passes strictTemplates, and passes every
// gate in this repo. They are well-formed code with real primitives and checked
// types that fails only when Angular actually assembles the graph. A static rule
// cannot see it; a browser sees it immediately.
//
// The cost of adding this was near zero, which is the uncomfortable part: the
// harness ALREADY boots every build for the responsive audit and was throwing
// the console away.
//
// This gate is deliberately NOT double-encoded the way the AST rules are. A
// thrown error is an observation the browser hands you, not a judgment about the
// code, so a second independent implementation would be the same three lines of
// Playwright API. The independence that matters is kept elsewhere: the responsive
// auditor captures page errors during its OWN navigation, in its own code path,
// and the driver records both. See responsive-spec.md.
//
// Usage:
//   node harness/gate/check-boot.mjs [--route dashboard --route roster ...]

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic, launchChromium } from '../playwright/serve-and-visit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');

// Noise that is not an application fault. Kept deliberately short: a gate that
// filters aggressively stops being a gate. Anything not listed here fails.
const IGNORE = [
  /favicon\.ico/i,
  /Failed to load resource.*404.*favicon/i,
];

const isNoise = (text) => IGNORE.some((re) => re.test(text));

/**
 * Visit one route and collect anything the page threw or logged as an error.
 * Uncaught exceptions arrive on `pageerror`; Angular's own logged errors (which
 * do not always throw past the framework) arrive as console messages of type
 * `error`, and NG0201 in particular surfaces that way under some zone configs,
 * so both are collected.
 */
export async function bootErrorsForRoute(browser, origin, route, { viewport = 1280, interact = true, maxClicks = 14 } = {}) {
  const context = await browser.newContext({ viewport: { width: viewport, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push({ kind: 'pageerror', text: String(err && err.message ? err.message : err) }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push({ kind: 'console.error', text: msg.text() });
  });
  const url = `${origin}/${route}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    // Angular bootstraps and renders asynchronously; a DI failure in a routed
    // component surfaces after navigation settles, not during it.
    await page.waitForTimeout(400);

    // A LOAD-time sweep alone is not enough, and the capstone proved it. The
    // NG0201 dialog fault hides behind `@if (vm.showRetireDialog())`: the
    // content is never instantiated until someone clicks Retire, so navigation
    // sees nothing and the screen looks perfect. Two of the three known DI
    // faults are load-time; the third is one click away.
    //
    // So click. Every visible, enabled button on the route, in order, bounded.
    // This is deliberately blunt rather than clever: it needs no knowledge of
    // the app, and an unknown app is exactly the situation a gate is for.
    // Playwright auto-dismisses native dialogs when no handler is attached, so
    // a stray window.confirm cannot wedge it.
    if (interact) {
      const buttons = page.locator('button:visible:not([disabled])');
      const n = Math.min(await buttons.count(), maxClicks);
      for (let i = 0; i < n; i++) {
        try {
          await buttons.nth(i).click({ timeout: 1500, noWaitAfter: true });
          await page.waitForTimeout(150);
          // A click may navigate away; go back so the remaining controls on the
          // route under test still get exercised.
          if (!page.url().endsWith(`/${route}`)) {
            await page.goto(url, { waitUntil: 'networkidle' });
            await page.waitForTimeout(200);
          }
        } catch {
          // A control that will not accept a click is not a runtime fault.
          // Detached nodes, overlays and timeouts are all normal here; only what
          // the PAGE throws counts, and that arrives on the listeners above.
        }
      }
    }
  } catch (e) {
    errors.push({ kind: 'navigation', text: String(e && e.message ? e.message : e) });
  } finally {
    await context.close();
  }
  return errors.filter((e) => !isNoise(e.text)).map((e) => ({ ...e, route }));
}

export async function assertBoots({ origin, routes, browser: given, viewport = 1280 }) {
  const browser = given ?? (await launchChromium());
  const failures = [];
  try {
    for (const route of routes) {
      failures.push(...(await bootErrorsForRoute(browser, origin, route, { viewport })));
    }
  } finally {
    if (!given) await browser.close();
  }
  return { failures };
}

function formatCorrectiveMessage(failures) {
  const byRoute = {};
  for (const f of failures) (byRoute[f.route] ??= []).push(f);
  const lines = [];
  lines.push(`Boot gate failed: ${failures.length} runtime error(s) across ${Object.keys(byRoute).length} route(s).`);
  lines.push('');
  for (const [route, fs_] of Object.entries(byRoute)) {
    lines.push(`  /${route}`);
    for (const f of fs_.slice(0, 5)) lines.push(`    [${f.kind}] ${f.text.split('\n')[0].slice(0, 200)}`);
    if (fs_.length > 5) lines.push(`    ... and ${fs_.length - 5} more`);
  }
  lines.push('');
  lines.push('The application compiles but throws when the browser renders it. These are almost always');
  lines.push('dependency-injection faults, which no compiler and no lint rule can see. The three this');
  lines.push('harness has measured, and what each one actually means:');
  lines.push('');
  lines.push('  "No icons have been provided"    -> NgIconsModule is an NgModule and resolves in the');
  lines.push('                                      ENVIRONMENT injector, so a component-level');
  lines.push('                                      provideIcons does not satisfy it. Import NgIcon');
  lines.push('                                      instead (see the house-style skill), or register at');
  lines.push('                                      application level in app.config.ts.');
  lines.push('  "No provider for BrnDialogRef"   -> hlm-dialog-content must sit on an *hlmDialogPortal');
  lines.push('                                      template; spartan supplies the dialog ref through');
  lines.push('                                      that portal. Rendering the content inline gives it');
  lines.push('                                      no provider. The spartan composition doc shows the');
  lines.push('                                      canonical shape; ask the spartan MCP if unsure.');
  lines.push('  "NullInjectorError: ...ViewModel" -> a component-scoped ViewModel was injected but not');
  lines.push('                                      listed in that component\'s own providers array.');
  lines.push('');
  lines.push('Fix the cause, then run `npm run check:boot` again. Do not work around it by removing the');
  lines.push('feature: a screen that does not render is not a screen that passes.');
  return lines.join('\n');
}

async function cli() {
  const args = process.argv.slice(2);
  const routes = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--route') routes.push(args[++i]);
  if (routes.length === 0) routes.push('dashboard', 'roster', 'detail/11', 'missions', 'threats', 'recruit', 'settings');

  // Built with the DEVELOPMENT configuration (optimization off) on purpose.
  // Against a production bundle this gate reports "ERROR T: NG0201", because the
  // injection token's class name has been minified to `T`, and a corrective
  // message that cannot name the missing provider is close to useless. Part 3
  // measured corrective-message quality taking a fix rate from 0 of 3 to 3 of 3,
  // so legibility here is load-bearing rather than cosmetic. Unminified, the
  // same failure reads "No provider found for BrnDialogRef", which points
  // straight at the fix. The responsive gate keeps the production build, since
  // layout geometry does not care about symbol names.
  execFileSync('npm run build -- --configuration development', { cwd: ROOT, stdio: 'inherit', shell: true });
  const srv = await serveStatic(DIST, { spaFallback: true });
  try {
    const { failures } = await assertBoots({ origin: srv.origin, routes });
    if (failures.length) {
      process.stderr.write(formatCorrectiveMessage(failures) + '\n');
      process.exit(1);
    }
    process.stdout.write(`boot check passed: ${routes.length} route(s) rendered with no runtime errors\n`);
  } finally {
    await srv.close();
  }
}

if (process.argv[1]?.endsWith('check-boot.mjs')) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
