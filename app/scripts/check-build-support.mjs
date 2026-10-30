// Shared plumbing for the build and Changes browser checks (`check:changes`, `check:build`).
// Both serve the production build under the exact CSP the desktop app declares, open the
// mock's scripted build of `2026-10-19-build-demo`, and fail on any runtime error.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium, serveStatic } from '../harness/playwright/serve-and-visit.mjs';
import { installClipping } from './clipping.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist', 'angular-jig', 'browser');

export const ROUTE = '/sdlc/commerce/2026-10-19-build-demo';
export const WIDTHS = [375, 768, 1280];
/** The Tailwind `md` breakpoint the views switch columns at: below it the layout stacks. */
export const MD = 768;

/** The CSP the desktop app ships, read from the Tauri config so the check cannot drift from it. */
export function desktopCsp() {
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const csp = conf?.app?.security?.csp;
  if (typeof csp !== 'string' || csp.length === 0) throw new Error('tauri.conf.json has no app.security.csp');
  return csp;
}

// Same short noise list as the boot gate; anything else fails.
const NOISE = [/favicon\.ico/i];

/** Serves the production build with the desktop CSP on every response and opens one page that records every error. `query` (for example `?demo=build-long`) picks a mock variant. */
export async function open({ width = 1280, height = 900, query = '' } = {}) {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`no production build at ${DIST}; run "npm run build" first`);
  const srv = await serveStatic(DIST, { spaFallback: true, headers: { 'content-security-policy': desktopCsp() } });
  const browser = await launchChromium();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await installClipping(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.some((re) => re.test(m.text()))) errors.push(`console.error: ${m.text()}`);
  });
  page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !NOISE.some((re) => re.test(r.url()))) errors.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  await page.goto(srv.origin + ROUTE + query, { waitUntil: 'networkidle' });
  return {
    page,
    browser,
    origin: srv.origin,
    errors,
    close: async () => {
      await browser.close();
      await srv.close();
    },
  };
}

/** Starts the scripted build from the change page and lands on the build page. */
export async function startBuild(page) {
  await page.getByRole('button', { name: 'Start build' }).click();
  // The build's preview opens first; the build starts on Start run.
  await page.getByRole('dialog').getByRole('button', { name: /^Start run$/ }).click();
  await page.getByRole('button', { name: 'Cancel build' }).waitFor();
}

/** Retries `read` until `ok(value)` holds or the time runs out, so a check waits for layout instead of sleeping. */
export async function eventually(page, read, ok, what, ms = 4000) {
  const until = Date.now() + ms;
  let value;
  for (;;) {
    value = await read();
    if (ok(value)) return value;
    if (Date.now() > until) throw new Error(`${what}: gave up waiting, last value ${JSON.stringify(value)}`);
    await page.waitForTimeout(50);
  }
}

/** True when the page has no horizontal scroll: the document is no wider than the viewport. */
export const noHorizontalScroll = (page) =>
  page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, body: document.body.scrollWidth };
  });

/**
 * The Changes strip's controls that lie outside the strip's own box (empty when none is cut off). The strip wraps or it fits; a
 * control past its right edge is clipped by the files area. The read-only line may end in an ellipsis, so only its box is measured.
 */
export const stripCutOff = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector('[data-testid="changes-strip"]');
    if (!strip) return ['no Changes strip'];
    const controls = [...strip.querySelectorAll('[role="radio"], button, .k-changes__stat, .k-changes__note')].filter((el) => el.getBoundingClientRect().width > 0);
    const out = controls.filter((el) => !window.kataClip.isInside(el, strip)).map((el) => (el.textContent ?? '').replace(/s+/g, ' ').trim() || el.className);
    return controls.length === 0 ? ['the Changes strip has no controls'] : out;
  });

/** Collects failures and prints them; exits non-zero if any. */
export function reporter(name) {
  const failures = [];
  return {
    check(ok, message) {
      if (!ok) failures.push(message);
      process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${message}\n`);
    },
    done() {
      if (failures.length > 0) {
        process.stderr.write(`${name} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
        process.exit(1);
      }
      process.stdout.write(`${name} passed\n`);
    },
  };
}
