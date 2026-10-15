import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serveStatic } from '../playwright/serve-and-visit.mjs';
import { assertResponsive } from './check-responsive.mjs';
import { formatCorrectiveMessage } from './responsive-guidance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'counter', 'fixtures', 'responsive');

async function check(file) {
  const srv = await serveStatic(fixtures, { spaFallback: false });
  try { return await assertResponsive({ origin: srv.origin, route: file, breakpoints: [375] }); }
  finally { await srv.close(); }
}

test('clean fixture passes', async () => {
  const { failures } = await check('clean.html');
  expect(failures.length).toBe(0);
}, 60000);

test('viewport-escape fixture fails', async () => {
  const { failures } = await check('viewport-escape.html');
  expect(failures.length).toBeGreaterThanOrEqual(1);
}, 60000);

test('scroll-exempt fixture passes', async () => {
  const { failures } = await check('scroll-exempt.html');
  expect(failures.length).toBe(0);
}, 60000);

test('corrective message names the breakpoint and selector', async () => {
  const { failures } = await check('viewport-escape.html');
  const msg = formatCorrectiveMessage(failures);
  expect(msg).toContain('375px');
  expect(msg).toContain('npm run check:responsive');
}, 60000);

test('hidden-drawer fixture passes: display:none, visibility:hidden, and aria-hidden (including a descendant of an aria-hidden ancestor) are all exempt', async () => {
  const { failures } = await check('hidden-drawer.html');
  expect(failures.length).toBe(0);
}, 60000);

test('offscreen-drawer fixture fails: a transform-translated element is still shown and stays a violation', async () => {
  const { failures } = await check('offscreen-drawer.html');
  expect(failures.some((f) => f.kind === 'element-escape')).toBe(true);
}, 60000);

test('visually-hidden fixture: sr-only spans are exempt but the real clip control still fails', async () => {
  const { failures } = await check('visually-hidden.html');
  // Exactly one failure: the 300x20-in-40x10 control's element-clip. If
  // either sr-only span were not exempted, this would be 2 or 3 instead.
  expect(failures.length).toBe(1);
  expect(failures[0].kind).toBe('element-clip');
  expect(failures.every((f) => !f.selector.includes('span'))).toBe(true);
}, 60000);

test('anchor parameter changes the measured subtree', async () => {
  const srv = await serveStatic(fixtures, { spaFallback: false });
  try {
    const defaultAnchor = await assertResponsive({ origin: srv.origin, route: 'anchor-scope.html', breakpoints: [375] });
    expect(defaultAnchor.failures.length).toBe(0);

    const bodyAnchor = await assertResponsive({
      origin: srv.origin, route: 'anchor-scope.html', breakpoints: [375], anchorSelector: 'body',
    });
    expect(bodyAnchor.failures.some((f) => f.kind === 'element-escape')).toBe(true);
  } finally { await srv.close(); }
}, 60000);
