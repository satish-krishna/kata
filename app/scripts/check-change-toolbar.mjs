// The change page toolbar, measured in a real browser. `check:responsive` runs it at 1280 and 1600 for a change in an
// early stage and for a finished one with three pull request links. jsdom has no layout, so a wrapped badge or a link
// painted over a pill can only be seen here.
//
// Every assertion is about what the person sees: the header does not scroll sideways, no two items in it share any
// pixels, the mode badge and the change name are each one line, and a truncated name carries its full text in a title.

export const CHANGE_ROUTES = [
  { route: 'sdlc/claims/2026-10-16-fraud-flag', name: 'a change in an early stage', pills: 4, links: 0 },
  { route: 'sdlc/claims/2026-10-18-photo-limits-shipped', name: 'a finished change with three pull requests', pills: 4, links: 0, menu: '3 PRs' },
];

/** Runs in the page: reads the toolbar's geometry. Returns plain data so the node side can judge it. */
function measure() {
  const header = document.querySelector('app-sdlc-toolbar header');
  if (!header) return null;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ');
  const lines = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top))).size;
  };
  const items = [
    ...header.querySelectorAll('.wb-seal, .k-modebadge, app-workspace-switcher, .k-crumbs, .k-branch, .k-pill, .k-prlinks__label, .k-prlinks a, [data-testid="pr-menu"], :scope > button'),
  ]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => ({ el, name: label(el), ...box(el) }));
  const nested = (a, b) => a.el.contains(b.el) || b.el.contains(a.el);
  const overlaps = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (nested(a, b)) continue;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 0.5 && y > 0.5) overlaps.push(`"${a.name}" over "${b.name}" (${Math.round(x)}px wide)`);
    }
  }
  const head = box(header);
  const beyond = items.filter((i) => i.right > head.right + 0.5).map((i) => `"${i.name}" ends at ${Math.round(i.right)}, header at ${Math.round(head.right)}`);
  const badge = header.querySelector('.k-modebadge');
  const crumb = header.querySelector('.k-crumbs__item');
  const links = Array.from(header.querySelectorAll('.k-prlinks a'));
  const menu = header.querySelector('[data-testid="pr-menu"]');
  const root = document.documentElement;
  return {
    menuText: menu ? menu.textContent.trim().replace(/s+/g, ' ') : null,
    menuClipped: menu ? menu.scrollWidth - menu.clientWidth : 0,
    menuInside: menu ? menu.getBoundingClientRect().right <= head.right + 0.5 && menu.getBoundingClientRect().left >= head.left - 0.5 : false,
    pageScroll: root.scrollWidth - root.clientWidth,
    headerScroll: header.scrollWidth - header.clientWidth,
    overlaps,
    beyond,
    pills: header.querySelectorAll('.k-pill').length,
    links: links.length,
    badgeLines: badge ? lines(badge) : 0,
    crumbLines: crumb ? lines(crumb) : 0,
    crumbTitle: crumb ? crumb.getAttribute('title') : null,
    crumbText: crumb ? crumb.textContent.trim() : null,
    linkNumbers: links.map((a) => {
      const num = a.querySelector('.k-prlinks__num');
      if (!num) return { text: a.textContent.trim(), visible: false };
      const n = num.getBoundingClientRect();
      const box = a.getBoundingClientRect();
      return { text: num.textContent.trim(), visible: n.width > 0 && n.left >= box.left - 0.5 && n.right <= box.right + 0.5 && n.right <= head.right + 0.5 };
    }),
    crumbClipped: crumb ? crumb.scrollWidth - crumb.clientWidth : 0,
    linkTitles: links.map((a) => ({ title: a.getAttribute('title'), text: a.textContent.trim() })),
  };
}

/** Opens one change route at one width and returns the failures as readable lines; empty means the toolbar is sound. */
export async function checkChangeToolbar(browser, origin, { route, name, pills, links, menu = null }, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const fails = [];
  try {
    await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    try {
      await page.waitForFunction(
        ([p, l, m]) => document.querySelectorAll('app-sdlc-toolbar header .k-pill').length === p && document.querySelectorAll('app-sdlc-toolbar header .k-prlinks a').length === l && (m === null) === !document.querySelector('app-sdlc-toolbar header [data-testid="pr-menu"]'),
        [pills, links, menu],
        { timeout: 5000 },
      );
    } catch {
      /* the measurement below reports what is actually there */
    }
    const m = await page.evaluate(measure);
    const at = `${name} at ${width}`;
    if (m === null) return [`${at}: no toolbar rendered`];
    if (m.pills !== pills) fails.push(`${at}: expected ${pills} stage pills, found ${m.pills}`);
    if (m.links !== links) fails.push(`${at}: expected ${links} pull request links, found ${m.links}`);
    if (m.pageScroll > 1) fails.push(`${at}: the page scrolls sideways by ${m.pageScroll}px`);
    if (m.headerScroll > 0) fails.push(`${at}: the toolbar's content is ${m.headerScroll}px wider than the toolbar (scrollWidth > clientWidth)`);
    for (const o of m.overlaps) fails.push(`${at}: toolbar items overlap: ${o}`);
    for (const b of m.beyond) fails.push(`${at}: an item runs past the toolbar: ${b}`);
    if (m.badgeLines !== 1) fails.push(`${at}: the mode badge is on ${m.badgeLines} lines, not one`);
    if (m.crumbLines !== 1) fails.push(`${at}: the change name is on ${m.crumbLines} lines, not one`);
    if (m.crumbTitle !== m.crumbText) fails.push(`${at}: the change name's title is ${JSON.stringify(m.crumbTitle)}, not its full text ${JSON.stringify(m.crumbText)}`);
    for (const l of m.linkNumbers) if (!l.visible) fails.push(`${at}: the pull request number "${l.text}" is clipped or missing`);
    if (menu === null ? m.menuText !== null : m.menuText !== menu) fails.push(`${at}: expected ${menu === null ? 'no pull request button' : `the button "${menu}"`}, found ${JSON.stringify(m.menuText)}`);
    if (menu !== null && (m.menuClipped > 0 || !m.menuInside)) fails.push(`${at}: the "${menu}" button is clipped or runs past the toolbar (${m.menuClipped}px cut off)`);
    if (m.crumbClipped > 0) fails.push(`${at}: the change name is truncated (${m.crumbClipped}px of it is cut off)`);
    for (const l of m.linkTitles) if (l.title !== l.text) fails.push(`${at}: the pull request link "${l.text}" has title ${JSON.stringify(l.title)}, not its full text`);
  } finally {
    await context.close();
  }
  return fails;
}

/** The strip under the toolbar keeps one height from tab to tab, so the page below it does not jump. */
export async function checkStripHeight(browser, origin, route, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const fails = [];
  try {
    await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle' });
    const heights = {};
    for (const tab of ['Intent', 'Spec', 'Plan', 'Build']) {
      await page.locator('app-sdlc-toolbar header [role="tab"]', { hasText: tab }).first().click();
      await page.waitForFunction((t) => document.querySelector('app-sdlc-toolbar header [role="tab"][aria-selected="true"]')?.textContent.trim().startsWith(t), tab, { timeout: 5000 });
      await page.waitForTimeout(150);
      if (tab === 'Build') await page.locator('[data-testid="changes-strip"]').waitFor({ timeout: 5000 }).catch(() => undefined);
      heights[tab] = await page.evaluate((t) => document.querySelector(t === 'Build' ? '[data-testid="changes-strip"]' : '[data-testid="strip"]')?.getBoundingClientRect().height ?? null, tab);
    }
    const values = Object.values(heights);
    if (values.some((h) => h === null)) fails.push(`strip heights at ${width}: a tab has no strip (${JSON.stringify(heights)})`);
    else if (new Set(values.map((h) => Math.round(h))).size !== 1) fails.push(`the strip changes height between tabs at ${width}: ${JSON.stringify(heights)}`);
  } finally {
    await context.close();
  }
  return fails;
}
