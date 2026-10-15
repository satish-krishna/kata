import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serveStatic, launchChromium } from '../playwright/serve-and-visit.mjs';
import { assertBoots, bootErrorsForRoute } from './check-boot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'counter', 'fixtures', 'boot');

async function boot(file, opts) {
  const srv = await serveStatic(fixtures, { spaFallback: false });
  const browser = await launchChromium();
  try {
    if (opts) return await bootErrorsForRoute(browser, srv.origin, file, opts);
    const { failures } = await assertBoots({ origin: srv.origin, routes: [file], browser });
    return failures;
  } finally {
    await browser.close();
    await srv.close();
  }
}

test('a page that renders and behaves reports no boot failures', async () => {
  expect(await boot('clean.html')).toEqual([]);
}, 60000);

test('a page that throws during render is caught', async () => {
  const f = await boot('throws-on-load.html');
  expect(f.length).toBeGreaterThanOrEqual(1);
  expect(f.some((x) => /HeroDetailViewModel/.test(x.text))).toBe(true);
}, 60000);

// The load-only case is the whole reason the sweep exists: the real NG0201
// dialog fault is behind an @if and never instantiates until a click.
test('a page that throws only on interaction is caught by the sweep', async () => {
  const f = await boot('throws-on-click.html');
  expect(f.some((x) => /BrnDialogRef/.test(x.text))).toBe(true);
}, 60000);

test('and is INVISIBLE without the sweep, which is why the sweep exists', async () => {
  expect(await boot('throws-on-click.html', { interact: false })).toEqual([]);
}, 60000);
