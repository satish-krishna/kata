import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { serveStatic, launchChromium, visitBreakpoint } from './serve-and-visit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'counter', 'fixtures', 'responsive');

test('serveStatic serves a real file', async () => {
  const srv = await serveStatic(fixtures, { spaFallback: false });
  try {
    const res = await fetch(`${srv.origin}/clean.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('app-hero-detail');
  } finally { await srv.close(); }
});

test('spaFallback=false returns 404 for unknown path', async () => {
  const off = await serveStatic(fixtures, { spaFallback: false });
  try {
    const res = await fetch(`${off.origin}/detail/11`);
    expect(res.status).toBe(404);
  } finally { await off.close(); }
});

test('spaFallback=true returns index.html for unknown path', async () => {
  const tmpDir = join(tmpdir(), `serve-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(join(tmpDir, 'index.html'), '<html>test index</html>');
  const srv = await serveStatic(tmpDir, { spaFallback: true });
  try {
    const res = await fetch(`${srv.origin}/detail/11`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('test index');
  } finally {
    await srv.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('path-traversal guard rejects encoded-segment and parent-dir attacks', async () => {
  const tmpDir = join(tmpdir(), `serve-guard-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  await writeFile(join(tmpDir, 'allowed.html'), '<html>ok</html>');
  const srv = await serveStatic(tmpDir, { spaFallback: false });
  try {
    const { origin } = srv;
    const originUrl = new URL(origin);

    // Test 1: encoded-segment attack (%2e%2e should be rejected)
    const encoded = await new Promise((resolve) => {
      const req = http.request({
        hostname: originUrl.hostname,
        port: originUrl.port,
        path: '/%2e%2e/etc/passwd',
        method: 'GET',
      }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(500));
      req.end();
    });
    expect(encoded).toBe(403);

    // Test 2: plain parent-dir attack (/../anything should be rejected by relative check)
    const plain = await new Promise((resolve) => {
      const req = http.request({
        hostname: originUrl.hostname,
        port: originUrl.port,
        path: '/../secret',
        method: 'GET',
      }, (res) => {
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(500));
      req.end();
    });
    expect(plain).toBe(403);

    // Test 3: verify normal file still works
    const normal = await fetch(`${origin}/allowed.html`);
    expect(normal.status).toBe(200);
  } finally {
    await srv.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('visitBreakpoint sets the viewport width', async () => {
  const srv = await serveStatic(fixtures, { spaFallback: false });
  const browser = await launchChromium();
  try {
    const { page, context } = await visitBreakpoint(browser, `${srv.origin}/clean.html`, 375);
    try {
      const w = await page.evaluate(() => window.innerWidth);
      expect(w).toBe(375);
    } finally { await context.close(); }
  } finally { await browser.close(); await srv.close(); }
}, 60000);
