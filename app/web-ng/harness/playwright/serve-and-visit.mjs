import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, relative, isAbsolute } from 'node:path';
import { chromium } from 'playwright';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.txt': 'text/plain', '.wasm': 'application/wasm',
};

export async function serveStatic(dir, { spaFallback = true } = {}) {
  const rootNorm = normalize(dir);
  const server = createServer(async (req, res) => {
    try {
      const rawReqPath = req.url.split('?')[0];
      if (rawReqPath.includes('%2e') || rawReqPath.includes('%2E')) { res.writeHead(403).end(); return; }
      const urlPath = decodeURIComponent(rawReqPath);
      let filePath = normalize(join(dir, urlPath));
      const rel = relative(rootNorm, filePath);
      if (rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403).end(); return; }
      let s = null;
      try { s = await stat(filePath); } catch { s = null; }
      if (s && s.isDirectory()) filePath = join(filePath, 'index.html');
      let body;
      try { body = await readFile(filePath); }
      catch {
        if (spaFallback) { filePath = join(dir, 'index.html'); body = await readFile(filePath); }
        else { res.writeHead(404).end('not found'); return; }
      }
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(500).end(String(e && e.message)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

export function launchChromium() {
  return chromium.launch();
}

export async function visitBreakpoint(browser, url, breakpoint) {
  const context = await browser.newContext({
    viewport: { width: breakpoint, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(50);
  const rendered = await page.evaluate(() =>
    !!document.body &&
    document.body.innerText.trim().length > 0 &&
    document.body.querySelectorAll('*').length > 1
  );
  if (!rendered) {
    throw new Error(`page rendered no substantive content at ${url} (viewport ${breakpoint}px); route may have failed to resolve`);
  }
  return { page, context };
}
