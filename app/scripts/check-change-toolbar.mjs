// The change page toolbar, measured in a real browser. `check:responsive` runs it at 1024, 1280 and 1600 for a change in an early
// stage, for a finished one with three pull request links and for the long-content fixtures below. jsdom has no layout, so a wrapped
// badge, a link painted over a pill or a name cut by a fraction of a pixel can only be seen here.
//
// Every assertion is about what the person sees, and clipping is always measured with scripts/clipping.mjs (fractional rects, never
// scrollWidth - clientWidth): no two items in the header share any pixels, every item lies inside the header, no item that never
// shrinks is clipped, the change name is whole for every change name the mock has, and when the toolbar is short of room the items give
// way in the order the table at the top of the toolbar's CSS block in workbench.css sets.
import { installClipping } from './clipping.mjs';

export const CHANGE_ROUTES = [
  { route: 'sdlc/claims/2026-10-16-fraud-flag', name: 'a change in an early stage', pills: 4, links: 0 },
  { route: 'sdlc/claims/2026-10-18-photo-limits-shipped', name: 'a finished change with three pull requests', pills: 4, links: 0, menu: '3 PRs' },
];

const LONG_WORKSPACE = 'acme-claims-regional-underwriting-plat-x'; // 40 characters
const LONG_CHANGE = '2026-10-16-fraud-flag-for-repeat-claimants-xx'; // 45 characters
const LONG_BRANCH = 'change/2026-10-09-adjuster-reassign';
const LONG_REPO = 'claims-adjuster-reassignment-service-x'; // 38 characters
const ONE_PR = 'sdlc/claims/2026-10-18-photo-limits-shipped?demo=one-pr';
const THREE_PRS = 'sdlc/claims/2026-10-18-photo-limits-shipped';

/** Long values set in the rendered DOM (the way checkPrPopover sets its repository name), so no fixture data is needed. */
export const LONG_FIXTURES = [
  { route: 'sdlc/claims/2026-10-16-fraud-flag', name: 'a 40-character workspace name', pills: 4, links: 0, fixture: { workspace: LONG_WORKSPACE } },
  { route: 'sdlc/claims/2026-10-16-fraud-flag', name: 'a 45-character change name', pills: 4, links: 0, fixture: { change: LONG_CHANGE } },
  { route: 'sdlc/claims/2026-10-09-adjuster-reassign', name: 'a long branch on another change', pills: 4, links: 0, fixture: { branch: LONG_BRANCH } },
  { route: THREE_PRS, name: 'three pull requests with a 40-character workspace name', pills: 4, links: 0, menu: '3 PRs', fixture: { workspace: LONG_WORKSPACE } },
  {
    route: THREE_PRS,
    name: 'three pull requests with a long workspace, change name and branch',
    pills: 4,
    links: 0,
    menu: '3 PRs',
    fixture: { workspace: LONG_WORKSPACE, change: LONG_CHANGE, branch: LONG_BRANCH },
  },
  { route: ONE_PR, name: 'one pull request with a 38-character repository name', pills: 4, links: 1, fixture: { prRepo: LONG_REPO } },
];

// The numbers in the shrink-order table (workbench.css), in pixels at the 16px root.
const SWITCHER = { natural: 256, min: 72 };
const BRANCH_FLOOR = 96;
const PILL_PADDING = { natural: 12, min: 4 };
const NEVER_SHRINK = { seal: 26, settings: 32 };
const EPS = 0.5;

/** Runs in the page: sets the long values of a fixture in the rendered DOM, the title and accessible name included. */
function applyFixture(fixture) {
  const header = document.querySelector('app-sdlc-toolbar header');
  if (fixture.workspace) {
    const trigger = header.querySelector('.k-wstrigger');
    header.querySelector('.k-wstrigger__name').textContent = fixture.workspace;
    trigger.setAttribute('title', fixture.workspace);
    trigger.setAttribute('aria-label', `Switch workspace, ${fixture.workspace}`);
  }
  if (fixture.change) {
    const item = header.querySelector('.k-crumbs__item');
    item.textContent = fixture.change;
    item.setAttribute('title', fixture.change);
  }
  if (fixture.prRepo) {
    const link = header.querySelector('.k-prlinks a');
    link.querySelector('.k-prlinks__repo').textContent = fixture.prRepo;
    link.setAttribute('title', link.textContent.trim());
  }
  if (fixture.branch) {
    const chip = header.querySelector('[data-testid="branch"]');
    chip.querySelector('.k-branch__text').textContent = fixture.branch;
    chip.setAttribute('title', `Not on ${fixture.branch}`);
    chip.setAttribute('aria-label', `Not on ${fixture.branch}`);
  }
}

/** Runs in the page: reads the toolbar's geometry. Returns plain data so the node side can judge it. */
function measure() {
  const { textClipped, isInside } = window.kataClip;
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
  const textWidth = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width;
  };
  const items = [
    ...header.querySelectorAll('.wb-seal, .k-modebadge, app-workspace-switcher, .k-wstrigger, .k-crumbs, .k-branch, .k-pill, .k-prlinks__label, .k-prlinks a, [data-testid="pr-menu"], :scope > button'),
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
      if (x > 0.01 && y > 0.01) overlaps.push(`"${a.name}" over "${b.name}" (${x.toFixed(2)}px wide)`);
    }
  }
  const head = box(header);
  const beyond = items.filter((i) => !isInside(i.el, header)).map((i) => `"${i.name}" spans ${i.left.toFixed(2)}-${i.right.toFixed(2)}, header ${head.left.toFixed(2)}-${head.right.toFixed(2)}`);
  const badge = header.querySelector('.k-modebadge');
  const crumb = header.querySelector('.k-crumbs__item');
  const links = Array.from(header.querySelectorAll('.k-prlinks a'));
  const menu = header.querySelector('[data-testid="pr-menu"]');
  const trigger = header.querySelector('.k-wstrigger');
  const root = document.documentElement;
  const chip = header.querySelector('[data-testid="branch"]');
  const chipText = chip ? chip.querySelector('.k-branch__text') : null;
  const chipIcon = chip ? chip.querySelector('.k-branch__icon') : null;
  const chipBox = chip ? chip.getBoundingClientRect() : null;
  const pills = Array.from(header.querySelectorAll('.k-pill')).map((p) => ({
    text: p.textContent.trim(),
    width: p.getBoundingClientRect().width,
    inner: textWidth(p.querySelector('.k-status')),
    clipped: textClipped(p, 'border'),
  }));
  return {
    menuText: menu ? menu.textContent.trim().replace(/\s+/g, ' ') : null,
    menuClipped: menu ? textClipped(menu) : 0,
    menuInside: menu ? isInside(menu, header) : false,
    pageScroll: root.scrollWidth - root.clientWidth,
    overlaps,
    beyond,
    pills,
    pillCount: pills.length,
    links: links.length,
    badgeLines: badge ? lines(badge) : 0,
    badgeClipped: badge ? textClipped(badge) : 0,
    crumbLines: crumb ? lines(crumb) : 0,
    crumbTitle: crumb ? crumb.getAttribute('title') : null,
    crumbText: crumb ? crumb.textContent.trim() : null,
    crumbClipped: crumb ? textClipped(crumb) : 0,
    separators: Array.from(header.querySelectorAll('.wb-sep')).filter((s) => s.getBoundingClientRect().width > 0).length,
    sealWidth: header.querySelector('.wb-seal').getBoundingClientRect().width,
    settingsWidth: header.querySelector(':scope > button.k-iconbtn').getBoundingClientRect().width,
    switcher: trigger
      ? {
          width: trigger.getBoundingClientRect().width,
          name: trigger.querySelector('.k-wstrigger__name').textContent.trim(),
          title: trigger.getAttribute('title'),
          label: trigger.getAttribute('aria-label'),
        }
      : null,
    linkNumbers: links.map((a) => {
      const num = a.querySelector('.k-prlinks__num');
      if (!num) return { text: a.textContent.trim(), visible: false };
      const n = num.getBoundingClientRect();
      return { text: num.textContent.trim(), visible: n.width > 0 && isInside(num, a) && isInside(num, header) };
    }),
    branch: chip
      ? {
          inside: chipBox.width > 0 && chipBox.height > 0 && isInside(chip, header),
          width: chipBox.width,
          iconShown: !!chipIcon && chipIcon.getBoundingClientRect().width > 0,
          textShown: !!chipText && chipText.getBoundingClientRect().width > 0,
          textClipped: chipText ? textClipped(chipText) : 0,
          chipClipped: textClipped(chip),
          textWhole: chipText ? chipText.textContent.trim() : null,
          label: chip.getAttribute('aria-label'),
          title: chip.getAttribute('title'),
        }
      : null,
    linkTitles: links.map((a) => ({ title: a.getAttribute('title'), text: a.textContent.trim() })),
    linkClipped: links.map((a) => textClipped(a)),
  };
}

/**
 * The give-way order of the table in workbench.css, judged from what was measured: an item may be shrunk only when every item above
 * it in the table is already at its minimum. Returns the violations as readable lines.
 */
export function shrinkOrderFails(m, width, at) {
  const fails = [];
  const branchAtMin = m.branch === null || width < 1280 || m.branch.width <= BRANCH_FLOOR + EPS;
  const switcherAtMin = m.switcher === null || m.switcher.width <= SWITCHER.min + EPS;
  const switcherShrunk = m.switcher !== null && m.switcher.width < SWITCHER.natural - EPS;
  const pillMin = (p) => p.inner + 2 * (1 + PILL_PADDING.min);
  const pillNatural = (p) => p.inner + 2 * (1 + PILL_PADDING.natural);
  const pillsAtMin = m.pills.every((p) => p.width <= pillMin(p) + EPS);
  const pillsShrunk = m.pills.some((p) => p.width < pillNatural(p) - EPS);
  if (switcherShrunk && !branchAtMin) fails.push(`${at}: the workspace switcher shrank (${m.switcher.width.toFixed(2)}px) while the branch chip was not yet at its minimum (${m.branch.width.toFixed(2)}px)`);
  if (pillsShrunk && !(branchAtMin && switcherAtMin)) {
    fails.push(`${at}: the pills' padding tightened while the branch chip (${m.branch ? m.branch.width.toFixed(2) : 'none'}px) or the workspace switcher (${m.switcher ? m.switcher.width.toFixed(2) : 'none'}px) was not at its minimum`);
  }
  if (m.crumbClipped > 0 && !(branchAtMin && switcherAtMin && pillsAtMin)) {
    fails.push(`${at}: the change name is truncated (${m.crumbClipped.toFixed(2)}px cut off) while the branch chip, the workspace switcher or the pill padding was not at its minimum (branch ${m.branch ? m.branch.width.toFixed(2) : 'none'}px, switcher ${m.switcher ? m.switcher.width.toFixed(2) : 'none'}px, pills ${m.pills.map((p) => p.width.toFixed(2)).join('/')}px)`);
  }
  return fails;
}

/** Opens one change route at one width and returns the failures as readable lines; empty means the toolbar is sound. */
export async function checkChangeToolbar(browser, origin, { route, name, pills, links, menu = null, fixture = null }, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await installClipping(context);
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
    if (fixture !== null) {
      await page.evaluate(applyFixture, fixture);
      await page.waitForTimeout(100);
    }
    const m = await page.evaluate(measure);
    const at = `${name} at ${width}`;
    if (m === null) return [`${at}: no toolbar rendered`];
    const longName = fixture !== null && !!fixture.change;
    const longBranch = fixture !== null && !!fixture.branch;
    if (m.pillCount !== pills) fails.push(`${at}: expected ${pills} stage pills, found ${m.pillCount}`);
    if (m.links !== links) fails.push(`${at}: expected ${links} pull request links, found ${m.links}`);
    if (m.pageScroll > 1) fails.push(`${at}: the page scrolls sideways by ${m.pageScroll}px`);
    for (const o of m.overlaps) fails.push(`${at}: toolbar items overlap: ${o}`);
    for (const b of m.beyond) fails.push(`${at}: an item is not inside the toolbar: ${b}`);
    if (m.badgeLines !== 1) fails.push(`${at}: the mode badge is on ${m.badgeLines} lines, not one`);
    if (m.crumbLines !== 1) fails.push(`${at}: the change name is on ${m.crumbLines} lines, not one`);
    if (m.crumbTitle !== m.crumbText) fails.push(`${at}: the change name's title is ${JSON.stringify(m.crumbTitle)}, not its full text ${JSON.stringify(m.crumbText)}`);
    for (const l of m.linkNumbers) if (!l.visible) fails.push(`${at}: the pull request number "${l.text}" is clipped or missing`);
    if (menu === null ? m.menuText !== null : m.menuText !== menu) fails.push(`${at}: expected ${menu === null ? 'no pull request button' : `the button "${menu}"`}, found ${JSON.stringify(m.menuText)}`);
    // The items that never shrink: the seal, the mode badge, the pills' text, the pull request control and the settings button.
    if (m.sealWidth !== NEVER_SHRINK.seal) fails.push(`${at}: the seal is ${m.sealWidth}px wide, not ${NEVER_SHRINK.seal}px`);
    if (m.settingsWidth !== NEVER_SHRINK.settings) fails.push(`${at}: the settings button is ${m.settingsWidth}px wide, not ${NEVER_SHRINK.settings}px`);
    if (m.badgeClipped > 0) fails.push(`${at}: the mode badge's text is clipped (${m.badgeClipped.toFixed(2)}px)`);
    for (const p of m.pills) if (p.clipped > 0) fails.push(`${at}: the "${p.text}" pill's text is clipped (${p.clipped.toFixed(2)}px)`);
    if (menu !== null && (m.menuClipped > 0 || !m.menuInside)) fails.push(`${at}: the "${menu}" button is clipped or runs past the toolbar (${m.menuClipped.toFixed(2)}px cut off)`);
    // A fixture repository name too long for its cap may end in an ellipsis; its title carries the full name.
    if (!(fixture && fixture.prRepo)) m.linkClipped.forEach((c, i) => c > 0 && fails.push(`${at}: pull request link ${i + 1} is clipped (${c.toFixed(2)}px)`));
    // The change name stays whole for every real change name; a fixture name that is too long for the room may be cut, and only last.
    if (!longName && m.crumbClipped > 0) fails.push(`${at}: the change name is truncated (${m.crumbClipped.toFixed(2)}px of it is cut off)`);
    for (const l of m.linkTitles) if (l.title !== l.text) fails.push(`${at}: the pull request link "${l.text}" has title ${JSON.stringify(l.title)}, not its full text`);
    // The workspace switcher carries the workspace name in its title and in its accessible name, since the name may be cut.
    if (m.switcher === null) fails.push(`${at}: no workspace switcher`);
    else {
      if (m.switcher.title !== m.switcher.name) fails.push(`${at}: the workspace switcher's title is ${JSON.stringify(m.switcher.title)}, not the workspace name ${JSON.stringify(m.switcher.name)}`);
      if (m.switcher.label !== `Switch workspace, ${m.switcher.name}`) fails.push(`${at}: the workspace switcher's accessible name is ${JSON.stringify(m.switcher.label)}, not "Switch workspace, ${m.switcher.name}"`);
    }
    // Order 1 of the table: below 1280 the separators are gone.
    if (width < 1280 && m.separators > 0) fails.push(`${at}: below 1280 the toolbar's separators are removed, but ${m.separators} are shown`);
    fails.push(...shrinkOrderFails(m, width, at));
    // The mock master repository is on main, never on change/<change>, so the warning chip is always there: an icon below 1280, the whole text from 1280.
    const b = m.branch;
    if (b === null) fails.push(`${at}: the master repository is not on change/<change> but no branch warning is shown`);
    else {
      if (!b.inside) fails.push(`${at}: the branch warning has no box or is not inside the toolbar`);
      if (!b.label || !b.label.includes(b.textWhole) || b.title !== b.label) fails.push(`${at}: the branch warning's title ${JSON.stringify(b.title)} and accessible name ${JSON.stringify(b.label)} must match and name the branch ${JSON.stringify(b.textWhole)}`);
      if (width < 1280) {
        if (!b.iconShown) fails.push(`${at}: below 1280 the branch warning must be the icon, and the icon is not visible`);
        if (b.textShown) fails.push(`${at}: below 1280 the branch warning must be the icon only, but its text is also shown`);
      } else {
        if (!b.textShown) fails.push(`${at}: from 1280 the branch warning shows its text, and the text is not visible`);
        if (b.iconShown) fails.push(`${at}: from 1280 the branch warning is the full chip, but the icon form is also shown`);
        if (!longBranch && (b.textClipped > 0 || b.chipClipped > 0)) fails.push(`${at}: the branch name is truncated (${Math.max(b.textClipped, b.chipClipped).toFixed(2)}px of it is cut off)`);
        if (longBranch && b.width < BRANCH_FLOOR - EPS) fails.push(`${at}: the long branch shrank below its ${BRANCH_FLOOR}px floor (${b.width.toFixed(2)}px)`);
      }
    }
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

/** The Build tab strip of a build-ready change and of a finished one with the pull request note: the widest sets of actions the strip carries. */
export const STRIP_STATES = [
  { route: 'sdlc/claims/2026-10-19-build-demo', name: 'a build-ready change' },
  { route: 'sdlc/claims/2026-10-18-photo-limits-shipped?demo=pr-fail', name: 'a finished build with three actions and the pull request note', note: true },
];

/** Nothing in the Build tab strip is ever cut off: every control sits inside the strip, the strip inside the window, no control's text is clipped, and from 1280 up the strip is one row. */
export async function checkBuildStrip(browser, origin, { route, name, note = false }, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await installClipping(context);
  const page = await context.newPage();
  const fails = [];
  const at = `${name} at ${width}`;
  try {
    await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle' });
    await page.locator('app-sdlc-toolbar header [role="tab"]', { hasText: 'Build' }).first().click();
    await page.locator('[data-testid="changes-strip"]').waitFor({ timeout: 5000 });
    if (note) await page.locator('[data-testid="changes-strip"] [data-testid="pr-note"]').waitFor({ timeout: 5000 });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const { textClipped, isInside } = window.kataClip;
      const strip = document.querySelector('[data-testid="changes-strip"]');
      const items = [...strip.querySelectorAll('button, [role="radio"], .k-changes__stat, .k-strip__file, [data-testid="pr-note"]')].filter((e) => e.getBoundingClientRect().width > 0);
      const name = (e) => (e.textContent.trim() || e.getAttribute('aria-label') || e.className).slice(0, 30);
      const mids = items.map((e) => {
        const r = e.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      return {
        outside: items.filter((e) => !isInside(e, strip)).map(name),
        // The read-only line and the pull request note truncate by design; every control's own text must be whole.
        clipped: items.filter((e) => !e.matches('.k-changes__note, [data-testid="pr-note"]') && textClipped(e, 'border') > 0).map(name),
        count: items.length,
        buttons: [...strip.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean),
        stripInside: isInside(strip, { left: 0, right: window.innerWidth, top: -Infinity, bottom: Infinity }),
        spread: Math.max(...mids) - Math.min(...mids),
      };
    });
    if (m.count === 0) fails.push(`${at}: the strip has no controls`);
    if (note && m.buttons.length < 3) fails.push(`${at}: expected the three stage actions, found ${JSON.stringify(m.buttons)}`);
    if (m.outside.length) fails.push(`${at}: controls cut off by the strip: ${JSON.stringify(m.outside)}`);
    if (m.clipped.length) fails.push(`${at}: controls whose text is clipped: ${JSON.stringify(m.clipped)}`);
    if (!m.stripInside) fails.push(`${at}: the strip runs past the window`);
    if (width >= 1280 && m.spread > 4) fails.push(`${at}: the strip is not one row (centers ${Math.round(m.spread)}px apart)`);
  } finally {
    await context.close();
  }
  return fails;
}

/** A long repository name in the pull request popover wraps inside it and the number stays whole. The name is set on the rendered link, so no fixture is needed. */
export async function checkPrPopover(browser, origin, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await installClipping(context);
  const page = await context.newPage();
  const fails = [];
  try {
    await page.goto(`${origin}/sdlc/claims/2026-10-18-photo-limits-shipped`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="pr-menu"]').click();
    await page.locator('[data-testid="pr-list"] a').first().waitFor();
    // The popover is positioned and has its width a moment after it opens; measuring before that sees a box of a few pixels.
    await page.waitForFunction(() => document.querySelector('[data-testid="pr-list"]').getBoundingClientRect().width > 200);
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const { isInside } = window.kataClip;
      const a = document.querySelector('[data-testid="pr-list"] a');
      const [name, num] = a.children;
      name.textContent = 'claims-adjuster-reassignment-service';
      num.textContent = '#1234';
      const list = document.querySelector('[data-testid="pr-list"]');
      const out = [...a.children].filter((s) => !isInside(s, list)).map((s) => s.textContent);
      return { out, numWhole: num.getClientRects().length === 1 };
    });
    if (m.out.length) fails.push(`pull request popover at ${width}: ${JSON.stringify(m.out)} runs out of the popover`);
    if (!m.numWhole) fails.push(`pull request popover at ${width}: the number is split across lines`);
  } finally {
    await context.close();
  }
  return fails;
}
