import { test, expect } from 'vitest';
import { chromium } from 'playwright';

test('chromium launches headless and evaluates in-page', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="x" style="width:120px">hi</div>');
    const w = await page.evaluate(() => document.getElementById('x').getBoundingClientRect().width);
    expect(w).toBe(120);
  } finally {
    await browser.close();
  }
}, 60000);
