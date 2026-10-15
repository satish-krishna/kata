// Shared parity view list. Imported by the Svelte baseline capture (app/scripts/screenshots.mjs
// --parity) and by the Angular check (app/web-ng/scripts/check-parity.mjs). One list, so the
// two sides can never capture different views.
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export const VIEWPORT = { width: 1440, height: 900 };

async function answerAsk(page) {
  const groups = page.locator('.k-ask__q');
  for (let i = 0; i < (await groups.count()); i++) {
    const g = groups.nth(i);
    if (await g.locator('textarea').count()) { await g.locator('textarea').fill('Confirmed — proceed.'); continue; }
    const opt = g.locator('.k-ask__opt, .k-ask__confirm-btn').first();
    if (await opt.count()) await opt.click();
  }
  await page.locator('.k-ask__foot button.k-btn--primary').click();
}

async function allowPermission(page) {
  const allow = page.getByRole('button', { name: 'Allow · resume' });
  await allow.waitFor({ timeout: 15000 });
  return allow;
}

async function finishRun(page) {
  await answerAsk(page);
  await (await allowPermission(page)).click();
  await page.waitForSelector('.wb-summary', { timeout: 15000 });
}

async function newSpec(page) {
  await page.getByRole('button', { name: 'New spec' }).click();
  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.count()) await discard.click();
  await page.waitForSelector('.wb-banner');
}

export const VIEWS = [
  { name: 'compose-seeded', path: '/', ready: '.wb-toolbar' },
  { name: 'compose-kit-search', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.getByLabel('Search kit').fill('git'); await p.locator('.wb-kit').scrollIntoViewIfNeeded(); await p.locator('.wb-kit').evaluate((e) => e.scrollIntoView({ block: 'start' })); } },
  { name: 'compose-new-empty', path: '/', ready: '.wb-toolbar', act: newSpec },
  { name: 'compose-validation', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await newSpec(p); await p.getByLabel('Spec name').fill('partial-spec');
      await p.waitForFunction(() => !document.querySelector('.wb-banner')?.textContent?.includes('name is required')); } },
  { name: 'dialog-discard', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.locator('textarea[rows="3"]').first().fill('changed');
      await p.getByRole('button', { name: 'New spec' }).click(); await p.waitForSelector('.k-dialog'); } },
  { name: 'dialog-save-preset', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.locator('.wb-presets').locator('xpath=preceding-sibling::textarea').fill('Preset body text.');
      await p.getByRole('button', { name: 'Save as preset' }).click(); await p.waitForSelector('.k-dialog'); } },
  { name: 'observe-ask', path: '/?demo=run', ready: '.k-ask' },
  { name: 'observe-permission', path: '/?demo=run', ready: '.k-ask',
    act: async (p) => { await answerAsk(p); await allowPermission(p); } },
  { name: 'observe-complete', path: '/?demo=run', ready: '.k-ask', act: finishRun },
  { name: 'observe-toolcards-open', path: '/?demo=run', ready: '.k-ask',
    act: async (p) => { await finishRun(p);
      const rows = p.locator('.k-toolcard__row');
      for (let i = 0; i < (await rows.count()); i++) { const r = rows.nth(i); if ((await r.getAttribute('aria-expanded')) === 'false') { await r.click(); await p.waitForFunction((el) => el.getAttribute('aria-expanded') === 'true', await r.elementHandle(), { timeout: 5000 }); } } } },
  { name: 'library-list', path: '/library', ready: '.wb-kata' },
  { name: 'library-detail', path: '/library', ready: '.wb-kata',
    act: async (p) => { await p.locator('.wb-hist').nth(3).click(); await p.waitForSelector('.wb-detail'); } },
  { name: 'focus-primary', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.keyboard.press('Tab'); await p.getByRole('button', { name: /^Run/ }).focus(); } },
  { name: 'hover-secondary', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.getByRole('button', { name: 'Open spec' }).hover(); } },
];

export async function launchBrowser() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }); }
    catch (e) { if (channel === 'msedge') throw new Error(`Could not launch Chrome or Edge.\n${e.message}`); }
  }
}

export async function captureAll(base, outDir) {
  await mkdir(outDir, { recursive: true });
  const browser = await launchBrowser();
  const written = [];
  try {
    for (const v of VIEWS) {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(base + v.path, { waitUntil: 'networkidle' });
      await page.waitForSelector(v.ready, { state: 'visible', timeout: 30000 });
      if (v.act) await v.act(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(450);
      const file = join(outDir, `${v.name}.png`);
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      written.push(file);
      await page.close();
    }
  } finally { await browser.close(); }
  return written;
}
