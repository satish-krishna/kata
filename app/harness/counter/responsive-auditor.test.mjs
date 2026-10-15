import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serveStatic } from '../playwright/serve-and-visit.mjs';
import { auditServed } from './responsive-auditor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'responsive');

async function auditFixture(file) {
  const srv = await serveStatic(fixtures, { spaFallback: false });
  try {
    return await auditServed({ origin: srv.origin, route: file, breakpoints: [375] });
  } finally { await srv.close(); }
}

test('clean fixture: no violations', async () => {
  const t = await auditFixture('clean.html');
  expect(t.totals.all).toBe(0);
}, 60000);

test('viewport-escape fixture flags the page scroll', async () => {
  const t = await auditFixture('viewport-escape.html');
  expect(t.totals['viewport-escape']).toBeGreaterThanOrEqual(1);
}, 60000);

test('element-escape fixture flags the escaping element', async () => {
  const t = await auditFixture('element-escape.html');
  expect(t.totals['element-escape']).toBeGreaterThanOrEqual(1);
}, 60000);

test('element-clip fixture flags the clipped element', async () => {
  const t = await auditFixture('element-clip.html');
  expect(t.totals['element-clip']).toBeGreaterThanOrEqual(1);
}, 60000);

test('element-clip-cross-axis fixture flags the horizontally clipped element even with overflow-y auto', async () => {
  const t = await auditFixture('element-clip-cross-axis.html');
  expect(t.totals['element-clip']).toBeGreaterThanOrEqual(1);
}, 60000);

test('scroll-exempt fixture is NOT flagged', async () => {
  const t = await auditFixture('scroll-exempt.html');
  expect(t.totals['element-escape']).toBe(0);
  expect(t.totals['element-clip']).toBe(0);
}, 60000);

test('determinism: two audits of the same fixture are byte-identical', async () => {
  const a = await auditFixture('element-escape.html');
  const b = await auditFixture('element-escape.html');
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
}, 60000);

test('hidden-drawer fixture: display:none, visibility:hidden, and aria-hidden (including a descendant of an aria-hidden ancestor) are all exempt', async () => {
  const t = await auditFixture('hidden-drawer.html');
  expect(t.totals['element-escape']).toBe(0);
  expect(t.totals['element-clip']).toBe(0);
}, 60000);

test('offscreen-drawer fixture: a transform-translated element is still shown and stays a violation', async () => {
  const t = await auditFixture('offscreen-drawer.html');
  expect(t.totals['element-escape']).toBeGreaterThanOrEqual(1);
}, 60000);

test('visually-hidden fixture: sr-only spans are exempt but the real clip control is still flagged', async () => {
  const t = await auditFixture('visually-hidden.html');
  expect(t.totals['element-escape']).toBe(0);
  // Exactly one element-clip: the 300x20-in-40x10 control. If either sr-only
  // span were not exempted, this count would be 2 or 3 instead.
  expect(t.totals['element-clip']).toBe(1);
  expect(t.violations.every((v) => !v.selector.includes('span'))).toBe(true);
}, 60000);

test('anchor parameter changes the measured subtree', async () => {
  const srv = await serveStatic(fixtures, { spaFallback: false });
  try {
    const defaultAnchor = await auditServed({ origin: srv.origin, route: 'anchor-scope.html', breakpoints: [375] });
    expect(defaultAnchor.totals['element-escape']).toBe(0);

    const bodyAnchor = await auditServed({
      origin: srv.origin, route: 'anchor-scope.html', breakpoints: [375], anchorSelector: 'body',
    });
    expect(bodyAnchor.totals['element-escape']).toBeGreaterThanOrEqual(1);
  } finally { await srv.close(); }
}, 60000);
