// Shared parity view list. Imported by the baseline capture and by the parity check
// (app/scripts/check-parity.mjs). One list, so the two sides can never capture different views.
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export const VIEWPORT = { width: 1440, height: 900 };

export async function answerAsk(page) {
  const send = page.getByRole('button', { name: 'Send answer · resume' });
  const next = page.locator('button[hlmQuestionnaireNext]:visible');
  for (let step = 0; step < 20; step++) {
    const item = page.locator('fieldset[hlmQuestionnaireItem]:visible').first();
    await item.waitFor({ timeout: 15000 });
    const choice = item.locator('label[hlmQuestionnaireChoice]:visible').first();
    if (await choice.count()) await choice.click();
    else await item.locator('input:visible, textarea:visible').first().fill('Confirmed — proceed.');
    if (await next.count()) { await next.first().click(); continue; }
    await send.click();
    return;
  }
  throw new Error('answerAsk: questionnaire did not reach Send');
}

// Every run opens its preview first, ?demo=run included; the run starts on Start run, and the scripted run then pauses on its first question.
export async function startRun(page) {
  await page.getByRole('dialog').getByRole('button', { name: /^Start run$/ }).click();
  await page.waitForSelector('.k-ask', { state: 'visible', timeout: 30000 });
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

const CHANGE_SPEC = '/sdlc/commerce/2026-10-12-product-photo-upload';

// An AI-SDLC agent run takes the page as the session view; its questionnaire is the first thing the scripted run asks.
async function lockAsk(page) {
  // ?demo=sdlc opens the run preview first; the scripted run starts on Start run.
  await page.getByRole('dialog').getByRole('button', { name: /^Start run$/ }).click();
  await page.locator('fieldset[hlmQuestionnaireItem]:visible').first().waitFor({ timeout: 15000 });
}

async function cancelToLeftovers(page) {
  await lockAsk(page);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForSelector('.k-left', { state: 'visible', timeout: 15000 });
}

const BUILD_CHANGE = '/sdlc/commerce/2026-10-19-build-demo';

// The scripted build of 2026-10-19-build-demo: Start build, then Start run in its preview, until the build page shows Cancel build.
async function startBuild(page) {
  await page.getByRole('button', { name: 'Start build' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Start run$/ }).click();
  await page.getByRole('button', { name: 'Cancel build' }).waitFor({ timeout: 30000 });
}

// Opens the modified file src/limits.rs from the files area in the Monaco diff editor, in whichever mode is on show.
async function openLimitsDiff(page) {
  if ((await page.locator('[data-area="files"]:not([inert])').count()) === 0) await page.keyboard.press('Control+3');
  await page.locator('[data-area="files"] [data-file="src/limits.rs"]').click();
  await page.locator('.monaco-diff-editor .editor.modified .view-line').first().waitFor({ timeout: 30000 });
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
      await p.getByRole('button', { name: 'New spec' }).click(); await p.getByRole('alertdialog').waitFor(); } },
  { name: 'dialog-save-preset', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.locator('.wb-presets').locator('xpath=preceding-sibling::textarea').fill('Preset body text.');
      await p.getByRole('button', { name: 'Save as preset' }).click(); await p.getByRole('dialog').waitFor(); } },
  { name: 'observe-ask', path: '/?demo=run', ready: '[role="dialog"]', act: startRun },
  { name: 'observe-permission', path: '/?demo=run', ready: '[role="dialog"]',
    act: async (p) => { await startRun(p); await answerAsk(p); await allowPermission(p); } },
  { name: 'observe-complete', path: '/?demo=run', ready: '[role="dialog"]',
    act: async (p) => { await startRun(p); await finishRun(p); } },
  { name: 'observe-toolcards-open', path: '/?demo=run', ready: '[role="dialog"]',
    act: async (p) => { await startRun(p); await finishRun(p);
      const rows = p.locator('.k-toolcard__row');
      for (let i = 0; i < (await rows.count()); i++) { const r = rows.nth(i); if ((await r.getAttribute('aria-expanded')) === 'false') { await r.click(); await p.waitForFunction((el) => el.getAttribute('aria-expanded') === 'true', await r.elementHandle(), { timeout: 5000 }); } } } },
  { name: 'library-list', path: '/library', ready: '.wb-kata' },
  { name: 'library-detail', path: '/library', ready: '.wb-kata',
    act: async (p) => { await p.locator('.wb-hist').nth(3).click(); await p.waitForSelector('.wb-detail'); } },
  { name: 'focus-primary', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.keyboard.press('Tab'); await p.getByRole('button', { name: /^Run/ }).focus(); } },
  { name: 'sdlc-mode', path: '/mode', ready: '.k-mode' },
  { name: 'sdlc-home', path: '/sdlc', ready: '.k-rowlink' },
  { name: 'sdlc-switcher-open', path: '/sdlc', ready: '.k-rowlink',
    act: async (p) => { await p.getByRole('button', { name: 'Switch workspace' }).click(); await p.getByRole('menuitemradio').first().waitFor({ state: 'visible' }); } },
  { name: 'sdlc-add-workspace-steps', path: '/sdlc?demo=sdlc-setup', ready: '.k-lock__steps' },
  { name: 'sdlc-lock-ask', path: CHANGE_SPEC + '?demo=sdlc', ready: '[role="dialog"]', act: lockAsk },
  { name: 'sdlc-leftovers', path: CHANGE_SPEC + '?demo=sdlc', ready: '[role="dialog"]', act: cancelToLeftovers },
  { name: 'sdlc-change-spec', path: CHANGE_SPEC, ready: '.k-md__diagram svg' },
  { name: 'sdlc-change-intent', path: CHANGE_SPEC, ready: '.k-md__diagram svg',
    act: async (p) => {
      await p.getByRole('tab', { name: /^Intent/ }).click();
      await p.getByRole('heading', { name: 'Photo upload on the product form' }).waitFor();
    } },
  { name: 'sdlc-change-plan', path: '/sdlc/commerce/2026-10-09-merchant-reassign', ready: '.k-docview' },
  { name: 'sdlc-feedback', path: '/sdlc/commerce/2026-10-09-merchant-reassign', ready: '.k-docview',
    act: async (p) => {
      await p.getByRole('button', { name: 'Re-run plan' }).click();
      await p.getByRole('dialog').getByRole('textbox', { name: 'What should change?' }).fill('R2 is wrong: team leads can reassign too.');
    } },
  { name: 'sdlc-run-settings', path: BUILD_CHANGE, ready: 'button:has-text("Start build")',
    act: async (p) => { await p.getByRole('button', { name: 'Start build' }).click(); await p.getByRole('region', { name: 'Run settings' }).waitFor(); } },
  { name: 'sdlc-build', path: BUILD_CHANGE, ready: 'button:has-text("Start build")',
    act: async (p) => { await startBuild(p); await p.locator('[data-waiting]:visible').first().waitFor({ timeout: 60000 }); await p.keyboard.press('Control+2'); await p.waitForTimeout(1500); } },
  { name: 'sdlc-changes', path: BUILD_CHANGE, ready: 'button:has-text("Start build")',
    act: async (p) => { await startBuild(p); await openLimitsDiff(p); } },
  { name: 'sdlc-review', path: BUILD_CHANGE, ready: 'button:has-text("Start build")',
    act: async (p) => {
      await startBuild(p);
      const notice = p.locator('[data-waiting]:visible').first();
      await notice.waitFor({ timeout: 60000 });
      await notice.getByRole('button', { name: 'Go to customer-portal' }).click();
      await p.locator('label', { hasText: 'Reuse it' }).click();
      await p.getByRole('button', { name: /Send answer/ }).click();
      await p.locator('[data-bar]').getByRole('button', { name: 'Declare done' }).waitFor({ timeout: 150000 });
      await p.keyboard.press('Control+4');
      await openLimitsDiff(p);
    } },
  { name: 'sdlc-done-pr', path: '/sdlc/commerce/2026-10-18-photo-limits-shipped', ready: '[data-testid="pr-menu"]',
    act: async (p) => { await p.locator('[data-testid="pr-menu"]').click(); await p.locator('[data-testid="pr-list"]').waitFor(); } },
  { name: 'sdlc-start-triage', path: '/sdlc?demo=start', ready: '[role="dialog"]',
    act: async (p) => { await p.getByRole('dialog').getByRole('button', { name: /^Start run$/ }).click(); await p.getByText('Take the light track').first().waitFor({ timeout: 30000 }); } },
  { name: 'sdlc-fix', path: '/sdlc/commerce/2026-10-22-photo-retry-fix', ready: '[data-testid="track-tag"]' },
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
