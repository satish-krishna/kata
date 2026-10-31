// The build page in a real browser (`npm run check:build`; run `npm run build` first).
//
// Drives the mock's scripted build (`commerce-core`, `customer-portal` and `billing-api` run together; `customer-portal` asks one question)
// on the production build at 1280 by 800, the smallest window, all on the change page's Build tab:
//   1. From the plan accepted to the pull requests opened on one page: start the build, answer `customer-portal`'s question, let the
//      review finish, read the findings, declare done and open the pull requests. At every step the URL stays on the change, the Build
//      tab stays selected and no `app-build-view` exists.
//   2. Each mode at its default arrangement (Ctrl+1 to Ctrl+4): no area switch, every area on show inside the window, nothing in the
//      bar, the waiting notice or an area cut off (R14.2, R14.3), the shape each mode promises (R2.2, R2.3, R2.4) and every action on
//      show or one click away without a mode change (R15.1).
//   3. Every area scrolls on its own: its scroll container overflows, scrolling reaches the last item and nothing else moves (R1.1),
//      and an area keeps its scroll place through a rearrangement (R1.2).
//   4. Every run's pane stays mounted while its area is not on show.
//   5. With the run preview open the way back to the changes list cannot be reached, and once it closes it can.
import { ROUTE, eventually, noHorizontalScroll, open, reporter, startBuild } from './check-build-support.mjs';

const { check, done } = reporter('check:build');
const { page, errors, close } = await open({ width: 1280, height: 800, query: '?demo=build-long' });
page.setDefaultTimeout(10000);

const REPOS = ['commerce-core', 'customer-portal', 'billing-api'];
const AREA_NAMES = { tasks: 'Tasks', activity: 'Activity', files: 'Changed files', findings: 'Findings' };
const MODES = [
  { key: 1, name: 'Overview' },
  { key: 2, name: 'Watch' },
  { key: 3, name: 'Changes' },
  { key: 4, name: 'Review' },
];
const area = (name) => page.locator(`[data-area="${name}"]`);
const onShow = (name) => page.locator(`[data-area="${name}"]:not([inert])`);
const notices = page.locator('[data-waiting]:visible');
// By CSS, not by role: an open dialog hides the page from the accessibility tree, and the page must be checked behind it too.
const buildTab = page.locator('[role="tab"]', { hasText: /^Build/ });
const barButtonOf = (name) => page.locator('[data-bar]').getByRole('button', { name });
const countOf = (sel) => page.locator(sel).count();
const settle = () => page.waitForTimeout(350);

/** R10.2: the engineer never leaves the build page and never sees another build screen. */
async function stays(step) {
  const url = new URL(page.url()).pathname;
  const tab = await buildTab.getAttribute('aria-selected');
  const old = await countOf('app-build-view');
  const pages = await countOf('app-build-page');
  check(url === ROUTE && tab === 'true' && old === 0 && pages === 1, `${step}: still on ${ROUTE} with the Build tab selected, one build page and no app-build-view (${url}, selected ${tab}, build views ${old}, build pages ${pages})`);
}

/** Runs one section of the check; a step that cannot be done (an element that is not there) fails the section, not the whole run. */
async function attempt(label, section) {
  try {
    await section();
  } catch (e) {
    check(false, `${label}: ${String(e.message).split('\n').slice(0, 3).join(' ')}`);
  }
}

/** Whether the element is visible and wholly inside the window. */
const inWindow = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.checkVisibility() && r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  });

/** Switches to a mode with its keys and puts it back to its default arrangement. */
async function enter(mode) {
  await page.keyboard.press(`Control+${mode.key}`);
  await page.getByRole('radio', { name: mode.name, exact: true }).waitFor();
  await page.locator('[data-bar]').getByRole('button', { name: 'Reset layout' }).click();
  await settle();
}

/**
 * What is cut off on the page: each control or label of the bar, the waiting notice and the header of every area on show, in both
 * directions, and the width of everything an area on show holds (its height scrolls). Fractional rects and the rendered text width, from clipping.mjs.
 */
const cutOff = () =>
  page.evaluate(() => {
    const clip = window.kataClip;
    const out = [];
    const say = (el) => (el.getAttribute('aria-label') ?? el.textContent ?? el.className).replace(/\s+/g, ' ').trim().slice(0, 40);
    // A tool call's command and the scroller's button truncate on purpose; a label with a screen-reader-only part has a text range wider than its box.
    const measured = (el) => !el.closest('app-tool-card, hlm-message-scroller') && !el.querySelector('.sr-only, .k-files__branch') && !el.classList.contains('sr-only');
    const watch = (container, where, both) => {
      const box = container.getBoundingClientRect();
      for (const el of container.querySelectorAll('button, [role="tab"], [role="radio"], .k-status, .k-lock__count, .k-bp__title, .k-bp__elapsed, .k-bp__fold, [data-finding-row]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || !el.checkVisibility()) continue;
        const inside = both ? clip.isInside(el, box) : r.left >= box.left - 0.02 && r.right <= box.right + 0.02;
        if (!inside) out.push(`${where}: "${say(el)}" lies outside its box`);
        else if (measured(el) && clip.textClipped(el, 'border') > 0) out.push(`${where}: "${say(el)}" has text cut off`);
      }
    };
    watch(document.querySelector('[data-bar]'), 'the bar', true);
    const notice = document.querySelector('.k-bp__notice');
    if (notice) watch(notice, 'the waiting notice', true);
    for (const a of document.querySelectorAll('[data-area]:not([inert])')) {
      watch(a.querySelector('.k-bp__head'), `the ${a.dataset.area} header`, true);
      watch(a.querySelector('.k-bp__body'), `the ${a.dataset.area} area`, false);
    }
    return out;
  });

/** The boxes the page keeps still while an area scrolls: the bar, the notice and every area. */
const boxes = () =>
  page.evaluate(() => {
    const read = (el) => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10) / 10);
    };
    const out = { bar: read(document.querySelector('[data-bar]')) };
    const notice = document.querySelector('.k-bp__notice');
    if (notice) out.notice = read(notice);
    for (const a of document.querySelectorAll('[data-area]')) out[a.dataset.area] = read(a);
    return out;
  });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Puts a control within reach and says how many clicks it took: 0 when it is on show, 1 when a rail name or a stack tab brings its
 * area back. The arrangement is reset afterwards, so the next check starts from the mode's default.
 */
async function reach(areaId, inside, what) {
  const target = () => area(areaId).locator(inside).first();
  const visible = async () => (await onShow(areaId).count()) === 1 && (await target().isVisible());
  let clicks = 0;
  if (!(await visible())) {
    const rail = page.locator('[data-rail]').getByRole('button', { name: new RegExp(`^Bring back ${AREA_NAMES[areaId]}`) });
    const tab = page.locator('[data-area]:not([inert]) [role="tablist"]').getByRole('tab', { name: new RegExp(`^${AREA_NAMES[areaId]}`) });
    if ((await rail.count()) > 0) {
      await rail.click();
      clicks = 1;
    } else if ((await tab.count()) > 0) {
      await tab.first().click();
      clicks = 1;
    }
    await settle();
  }
  let ok = await visible();
  if (ok) {
    await target().scrollIntoViewIfNeeded();
    ok = await inWindow(target());
  }
  if (clicks > 0) await page.locator('[data-bar]').getByRole('button', { name: 'Reset layout' }).click();
  await settle();
  return { ok, clicks, what };
}

/** Whether `what` is on show or one click away in the current mode. */
async function reachable(mode, action, areaId, inside) {
  const r = await reach(areaId, inside, action);
  check(r.ok && r.clicks <= 1, `${mode.name}: can ${action} ${r.clicks === 0 ? 'where it is on show' : 'one click away'} without a mode change`);
}

/** Scrolls an area's own scroll container through its whole length and reports what came into view. */
const sweep = (scroller, itemSel) =>
  scroller.evaluate(async (el, sel) => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const items = () => [...el.querySelectorAll(sel)].filter((it) => it.getBoundingClientRect().height > 0);
    const seen = new Set();
    const mark = () => {
      const box = el.getBoundingClientRect();
      for (const it of items()) {
        const r = it.getBoundingClientRect();
        if (r.bottom > box.top + 0.5 && r.top < box.bottom - 0.5) seen.add(it);
      }
    };
    const overflow = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    el.scrollTop = 0;
    await frame();
    mark();
    for (let guard = 0; el.scrollTop + el.clientHeight < el.scrollHeight - 1 && guard < 500; guard++) {
      const before = el.scrollTop;
      el.scrollTop = before + Math.max(20, el.clientHeight * 0.7);
      await frame();
      mark();
      if (el.scrollTop === before) break;
    }
    el.scrollTop = el.scrollHeight;
    await frame();
    mark();
    const all = items();
    const last = all.length > 0 ? all[all.length - 1].getBoundingClientRect() : null;
    const box = el.getBoundingClientRect();
    return { ...overflow, total: all.length, seen: all.filter((it) => seen.has(it)).length, lastInView: last !== null && last.top >= box.top - 0.5 && last.bottom <= box.bottom + 0.5 };
  }, itemSel);

/** R1.1 for one area: its scroll container overflows, every item comes into view in turn, the last is in view and nothing else moved. */
async function scrollsOnItsOwn(label, scroller, itemSel) {
  await scroller.waitFor();
  const before = await boxes();
  const r = await sweep(scroller, itemSel);
  check(r.scrollHeight > r.clientHeight + 1, `R1.1 ${label}: the area overflows the room it has at 1280 by 800 (${r.scrollHeight} of ${r.clientHeight})`);
  check(r.total > 0 && r.seen === r.total, `R1.1 ${label}: every one of its ${r.total} items came into view while scrolling (${r.seen} seen)`);
  check(r.lastInView, `R1.1 ${label}: scrolled to its end, the last item is in view`);
  check(same(before, await boxes()), `R1.1 ${label}: the bar, the waiting notice and the other areas stayed where they were`);
}

/** The scroll place of a scroll container, or -1 when it is not there. */
const placeOf = (scroller) => scroller.evaluate((el) => el.scrollTop).catch(() => -1);
/** Scrolls a container part way down and returns where it stopped. */
async function scrollPartWay(scroller) {
  await scroller.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
  });
  await page.waitForTimeout(150);
  return placeOf(scroller);
}
/** R1.2: the same place after a rearrangement, within a pixel. */
function keptPlace(label, before, after) {
  check(before > 20, `R1.2 ${label}: scrolled part way first (${before})`);
  check(Math.abs(before - after) <= 1, `R1.2 ${label}: the area shows the same place after the rearrangement (${before} then ${after})`);
}

const tasksBody = area('tasks').locator('.k-bp__body');
/** Narrows the task list to one choice of the filter (All, Open, Departed, Done). */
async function filterTo(name) {
  await area('tasks').getByRole('radio', { name: new RegExp(`^${name} `) }).click();
  await settle();
}
const activityViewport = area('activity').locator('hlm-message-scroller-viewport:visible').first();
const filesList = area('files').locator('.k-changes__left');
const findingsBody = area('findings').locator('.k-bp__body');

try {
  await stays('plan accepted');
  await startBuild(page);
  await stays('the build started');
  await notices.first().waitFor();
  // The Changes strip exists once an agent has changed something; the checks below look for its controls in every mode.
  await area('files').locator('[data-file]').first().waitFor({ state: 'attached' });

  // Stop one repository the way the engineer would, so "continue a stopped repository" can be reached in every mode below.
  const group = (repo) => page.locator('[data-group]', { hasText: repo });
  await group('commerce-core').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Continue commerce-core' }).waitFor();

  // R14.2, R14.3, R2.2, R2.3, R2.4 and the live half of R15.1, one mode at a time at its default arrangement.
  for (const mode of MODES) {
    await enter(mode);
    const text = await notices.first().innerText();
    check(text.includes('customer-portal') && /answer/.test(text), `${mode.name}: the notice names customer-portal and what it waits for (${JSON.stringify(text.replace(/\s+/g, ' '))})`);
    check((await page.getByRole('radiogroup', { name: 'Build areas' }).count()) === 0, `R14.3 ${mode.name}: no area switch, the page shows the mode's arrangement`);
    const shown = await page.locator('[data-area]:not([inert])').evaluateAll((els) => els.map((el) => el.dataset.area));
    check(shown.length >= 2, `R14.3 ${mode.name}: several areas are on show together (${shown.join(', ')})`);
    for (const name of shown) check(await inWindow(area(name)), `R14.2 ${mode.name}: the ${name} area has its whole width and height inside the window`);
    const cut = await cutOff();
    check(cut.length === 0, `R14.2 ${mode.name}: nothing in the bar, the waiting notice or an area on show is cut off${cut.length ? ` (${cut.join('; ')})` : ''}`);
    check(await inWindow(page.locator('[data-bar]')), `R14.2 ${mode.name}: the bar is inside the window`);
    check(await inWindow(notices.first()), `R14.2 ${mode.name}: the waiting notice is inside the window`);
    const sideways = await noHorizontalScroll(page);
    check(sideways.scrollWidth <= sideways.clientWidth && sideways.body <= sideways.clientWidth, `${mode.name}: no horizontal page scroll (${sideways.scrollWidth} of ${sideways.clientWidth})`);

    const box = async (name) => area(name).boundingBox();
    if (mode.key === 1) {
      const tasks = await box('tasks');
      const activity = await box('activity');
      const groups = await tasksBody.locator('[data-heading]').evaluateAll((els) => els.map((el) => el.querySelector('.k-bp__name')?.textContent?.trim()));
      const bar = (await page.locator('[data-bar] .k-lock__count').innerText()).trim();
      const taskCount = await tasksBody.locator('[data-task]').count();
      const labels = await tasksBody.locator('[data-heading] .k-status, [data-task] .k-status').evaluateAll((els) => els.filter((el) => (el.textContent ?? '').trim() === '').length);
      check(REPOS.every((r) => groups.includes(r)) && taskCount === Number(bar.split('/')[1].split(' ')[0]) && labels === 0, `R2.2 Overview: the tasks area lists every repository (${groups.join(', ')}) and all ${taskCount} tasks, each with a status`);
      check(activity.width < tasks.width, `R2.2 Overview: the activity is narrower than the tasks (${Math.round(activity.width)} against ${Math.round(tasks.width)})`);
    }
    if (mode.key === 2) {
      const tasks = await box('tasks');
      const activity = await box('activity');
      const groups = await tasksBody.locator('[data-heading] .k-bp__name').evaluateAll((els) => els.map((el) => el.textContent?.trim()));
      check(activity.width > 640, `R2.3 Watch: the activity is wider than half the window (${Math.round(activity.width)})`);
      check(tasks.width <= 300, `R2.3 Watch: the tasks strip is at most 300 pixels wide (${Math.round(tasks.width)})`);
      check(REPOS.every((r) => groups.includes(r)), `R2.3 Watch: the strip shows every repository (${groups.join(', ')})`);
    }
    if (mode.key === 3) {
      const files = await box('files');
      const activity = await box('activity');
      const list = await area('files').locator('.k-changes__left').boundingBox();
      const main = await area('files').locator('.k-changes__main').boundingBox();
      check(list !== null && main !== null && list.x + list.width <= main.x + 1 && Math.abs(list.y - main.y) < 2, `R2.4 Changes: the file list and the diff sit side by side in the middle (list ${JSON.stringify(list)}, diff ${JSON.stringify(main)})`);
      check(list !== null && main !== null && main.width > list.width, `R2.4 Changes: the diff is wider than the list (${Math.round(main?.width ?? 0)} against ${Math.round(list?.width ?? 0)})`);
      check(activity.y >= files.y + files.height - 1, `R2.4 Changes: the activity is below the changed files (${Math.round(activity.y)} against ${Math.round(files.y + files.height)})`);
    }

    // R15.1, the actions a running build offers.
    const goTo = notices.first().getByRole('button', { name: 'Go to customer-portal' });
    check(await inWindow(goTo), `R15.1 ${mode.name}: the notice's Go to customer-portal is inside the window`);
    await goTo.click();
    await settle();
    const ask = await reach('activity', 'label:has-text("Reuse it")', 'answer a question');
    check(ask.ok, `R15.1 ${mode.name}: after Go to customer-portal the question can be answered${ask.clicks ? ' one click away' : ' where it is on show'}`);
    await enter(mode);
    // billing-api pauses on a permission check (the long demo's script); its notice leads to the card with both controls.
    const goBilling = notices.getByRole('button', { name: 'Go to billing-api' });
    check(await inWindow(goBilling), `R15.1 ${mode.name}: the notice's Go to billing-api is inside the window`);
    await goBilling.click();
    await settle();
    const allow = await reach('activity', 'button:visible:has-text("Allow")', 'approve an action');
    check(allow.ok, `R15.1 ${mode.name}: after Go to billing-api the action can be approved${allow.clicks ? ' one click away' : ' where it is on show'}`);
    await enter(mode);
    await goBilling.click();
    await settle();
    const deny = await reach('activity', 'button:visible:text-is("Deny")', 'refuse an action');
    check(deny.ok, `R15.1 ${mode.name}: after Go to billing-api the action can be refused${deny.clicks ? ' one click away' : ' where it is on show'}`);
    await enter(mode);
    check(await inWindow(page.locator('[data-bar]').getByRole('button', { name: 'Cancel build' })), `R15.1 ${mode.name}: cancel the build is in the bar`);
    await reachable(mode, 'cancel one repository\'s run', 'tasks', '[data-group]:has-text("customer-portal") button:text-is("Cancel")');
    await reachable(mode, 'continue a stopped repository', 'tasks', 'button:text("Continue commerce-core")');
    for (const part of ['Whole change', 'Committed', 'Uncommitted']) {
      await reachable(mode, `view ${part === 'Whole change' ? 'the whole change' : part === 'Committed' ? 'only committed work' : 'only uncommitted work'}`, 'files', `[role="radio"]:text-is("${part}")`);
    }
    await stays(`${mode.name} at its default`);
  }

  // Approve billing-api's action from its notice, so its run goes on to finish its tasks.
  await attempt("approving billing-api's action", async () => {
    await enter(MODES[1]);
    await notices.getByRole('button', { name: 'Go to billing-api' }).click();
    await settle();
    await page.getByRole('button', { name: /^Allow/ }).first().click();
    await eventually(page, () => notices.filter({ hasText: 'billing-api' }).count(), (n) => n === 0, "billing-api's notice going away");
    check(true, "approving the action clears billing-api's notice");
  });

  // R16.2 and R12.1: continuing the stopped repository opens its preview first; the run starts from it.
  await enter(MODES[0]);
  await page.getByRole('button', { name: 'Continue commerce-core' }).click();
  const preview = page.getByRole('dialog');
  await preview.getByRole('button', { name: /^Start run$/ }).waitFor();
  await eventually(page, () => preview.getByRole('button', { name: /^Start run$/ }).isEnabled(), (on) => on, 'the continue preview resolving');
  const dialog = await preview.boundingBox();
  check(dialog !== null && dialog.x >= 0 && dialog.y >= 0 && dialog.x + dialog.width <= 1280 && dialog.y + dialog.height <= 800, `the continue preview fits inside 1280 by 800 (${JSON.stringify(dialog)})`);
  check((await preview.innerText()).includes('No push'), 'the continue preview lists the safety rules');
  await preview.getByRole('button', { name: /^Start run$/ }).click();
  await stays('commerce-core stopped and continued');

  // Every run keeps folding events while its area is hidden, so a hidden run's question is never missed.
  const runs = await countOf('[data-session]');
  check(runs >= REPOS.length && (await countOf('[data-pane]')) >= REPOS.length, `every run's pane stays mounted while its area is not on show (${runs} runs)`);

  // Wait until the repositories that are not asking have finished their tasks, so the conversation read below is quiet.
  for (const repo of ['commerce-core', 'billing-api']) {
    await attempt(`${repo} finishing its tasks`, async () => {
      await group(repo).waitFor();
      await eventually(page, () => group(repo).locator('[data-heading] .k-status', { hasText: /^Finished$/ }).count(), (n) => n === 1, `${repo} finishing its tasks`, 90000);
    });
  }

  // R1.1 activity: Watch, the turns of commerce-core's conversation. R1.2 activity: the area moves to another side and keeps its place.
  await attempt('R1.1 activity', async () => {
    await enter(MODES[1]);
    await group('commerce-core').locator('.k-bp__name').click();
    await settle();
    await scrollsOnItsOwn('activity', activityViewport, 'hlm-message-scroller-item');
  });
  // Moving the area changes its width, so its text reflows and the same scrollTop cannot mean the same place after a one-way move; the item at
  // the top is what must stay there. Moving it back does not restore the old width by itself (the middle comes back about 60 pixels narrower),
  // so the layout is reset to the mode default, the width it was scrolled at; the scroll place must then be the one it had, within a pixel.
  await attempt('R1.2 activity', async () => {
    const topItem = () =>
      activityViewport.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const items = [...el.querySelectorAll('hlm-message-scroller-item')];
        return items.findIndex((it) => it.getBoundingClientRect().bottom > top + 1);
      });
    const placeBefore = await scrollPartWay(activityViewport);
    const itemBefore = await topItem();
    const home = await area('activity').getAttribute('data-place');
    await area('activity').getByRole('button', { name: 'Place Activity' }).click();
    await page.getByRole('menuitem', { name: 'Right' }).click();
    await settle();
    check((await area('activity').getAttribute('data-place')) === 'right', 'R1.2 activity: the area moved to the right side');
    check(placeBefore > 20 && itemBefore > 0, `R1.2 activity: scrolled part way first (${placeBefore}, item ${itemBefore} at the top)`);
    const itemAfter = await topItem();
    check(itemAfter === itemBefore, `R1.2 activity: the same item is at the top after the move (item ${itemBefore} then ${itemAfter})`);
    await area('activity').getByRole('button', { name: 'Place Activity' }).click();
    await page.getByRole('menuitem', { name: home.charAt(0).toUpperCase() + home.slice(1), exact: true }).click();
    await settle();
    check((await area('activity').getAttribute('data-place')) === home, `R1.2 activity: the area moved back to its ${home} place`);
    await page.locator('[data-bar]').getByRole('button', { name: 'Reset layout' }).click();
    await settle();
    keptPlace('activity, moved away and back', placeBefore, await placeOf(activityViewport));
  });

  // R1.1 changed files: Changes, the files in the list, then the lines of the change to one file.
  await attempt('R1.1 changed files, the list', async () => {
    await enter(MODES[2]);
    await scrollsOnItsOwn('changed files, the list', filesList, '[data-file]');
  });
  await attempt('R1.2 changed files', async () => {
    const listBefore = await scrollPartWay(filesList);
    await area('files').getByRole('button', { name: 'Focus Changed files' }).click();
    await settle();
    check((await page.locator('[data-focus-banner]').count()) === 1, 'R1.2 changed files: the area is in focus');
    await page.locator('[data-focus-banner]').getByRole('button', { name: 'Back to Changes' }).click();
    await settle();
    keptPlace('changed files', listBefore, await placeOf(filesList));
  });
  await attempt('R1.1 changed files, the lines of the change', async () => {
    await area('files').locator('[data-file="src/schema.rs"]').first().click();
    const editor = area('files').locator('.monaco-diff-editor');
    await editor.waitFor({ timeout: 20000 });
    await editor.locator('.view-line', { hasText: 'FIELD_' }).first().waitFor({ timeout: 20000 });
    const beforeDiff = await boxes();
    const box = await editor.boundingBox();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    const seen = new Set();
    let lastLine = false;
    for (let i = 0; i < 120 && !lastLine; i++) {
      const texts = await editor.locator('.view-line').allInnerTexts();
      for (const t of texts) for (const m of t.matchAll(/FIELD_(\d+)/g)) seen.add(Number(m[1]));
      lastLine = texts.some((t) => t.includes('END_OF_SCHEMA'));
      if (!lastLine) {
        await page.mouse.wheel(0, 150);
        await page.waitForTimeout(60);
      }
    }
    const endBox = await editor.locator('.view-line', { hasText: 'END_OF_SCHEMA' }).first().boundingBox();
    check(lastLine && endBox !== null && endBox.y >= box.y - 0.5 && endBox.y + endBox.height <= box.y + box.height + 0.5, 'R1.1 changed files, the lines of the change: scrolled to its end, the last line is in view');
    check(seen.size >= 100, `R1.1 changed files, the lines of the change: ${seen.size} lines of the change came into view while scrolling`);
    check(same(beforeDiff, await boxes()), 'R1.1 changed files, the lines of the change: the bar, the waiting notice and the other areas stayed where they were');
  });

  await enter(MODES[0]);

  // Answer from the pinned notice, wherever it is on show.
  await enter(MODES[1]);
  await notices.first().getByRole('button', { name: 'Go to customer-portal' }).click();
  await page.locator('label', { hasText: 'Reuse it' }).waitFor();
  await page.locator('label', { hasText: 'Reuse it' }).click();
  await page.getByRole('button', { name: /Send answer/ }).click();
  await eventually(page, () => notices.count(), (n) => n === 0, 'the notice going away');
  check(true, 'answering clears the notice');
  await stays('the question answered');

  // The build finishes by itself: every task in the build log, the review run, and the bar offers Declare done.
  const tasks = () => page.locator('[data-bar] .k-lock__count').innerText();
  const finished = await eventually(page, tasks, (t) => t.split(' ')[0].split('/')[0] === t.split(' ')[0].split('/')[1], 'every task reaching the build log', 90000).catch((e) => e.message);
  check(/^(\d+)\/\1 /.test(String(finished)), `every task is in the build log (${JSON.stringify(finished)})`);
  const barButton = (name) => page.locator('[data-bar]').getByRole('button', { name });
  const declare = barButton('Declare done');
  await declare.waitFor({ timeout: 60000 });
  check(await inWindow(declare), 'Declare done is in the bar once the build and its review are finished');
  await stays('the review finished');

  // R15.1, the actions a finished build offers, in every mode.
  for (const mode of MODES) {
    await enter(mode);
    check(await inWindow(declare), `R15.1 ${mode.name}: declare the change done is in the bar`);
    check(await inWindow(barButton('Another round')), `R15.1 ${mode.name}: ask for another round is in the bar`);
    await reachable(mode, 'read the review\'s findings', 'findings', 'app-findings-list .k-findings__item');
    await reachable(mode, 'see every departure from the plan', 'findings', '[data-testid="departures"] .k-findings__item');
    await listIsWhole(mode);
  }

  // R1.1, R2.1, R4.1 and R14.2 at the default of each mode, with the review finished: the filter, the fold rows and the Review group's rows.
async function listIsWhole(mode) {
  await attempt(`${mode.name}: the task list`, async () => {
    const tasks = await reach('tasks', '[role="radiogroup"][aria-label="Show tasks"]', 'narrow the task list');
    check(tasks.ok && tasks.clicks <= 1, `R2.1 ${mode.name}: the filter can be reached without a mode change`);
    await enter(mode);
    if ((await onShow('tasks').count()) === 0) return;
    const shape = await area('tasks').evaluate((el) => {
      const body = el.querySelector('.k-bp__body');
      const box = body.getBoundingClientRect();
      const wide = [...body.querySelectorAll('[role="radio"], .k-bp__fold, [data-finding-row], [data-low-fold], [data-review-counts]')].filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
      }).length;
      return {
        radios: body.querySelectorAll('[role="radio"]').length,
        folds: body.querySelectorAll('[data-fold]').length,
        rows: body.querySelectorAll('[data-finding-row]').length,
        lows: body.querySelectorAll('[data-low-fold]').length,
        counts: body.querySelectorAll('[data-review-counts] .k-status').length,
        wide,
      };
    });
    check(shape.radios === 4, `R2.1 ${mode.name}: the filter offers All, Open, Departed and Done (${shape.radios})`);
    check(shape.folds === REPOS.length, `R1.1 ${mode.name}: each finished repository folds its finished tasks into one line (${shape.folds})`);
    check(shape.rows > 0 && shape.lows > 0 && shape.counts >= 2, `R4.1 ${mode.name}: the Review group lists finding rows, folds its low ones and counts per severity (${shape.rows} rows, ${shape.lows} low folds, ${shape.counts} counts)`);
    check(shape.wide === 0, `R14.2 ${mode.name}: the filter, the fold rows and the finding rows lie inside the tasks area's width (${shape.wide} outside)`);
    // A finding row shows one line: a first sentence longer than the row is cut with an ellipsis, not wrapped.
    const longRow = await area('tasks').locator('[data-finding-row]', { hasText: 'photo count is read twice' }).first().locator('.k-bp__finding-text').evaluate((el) => ({ height: el.clientHeight, lineHeight: parseFloat(getComputedStyle(el).lineHeight) || el.clientHeight, overflow: getComputedStyle(el).textOverflow, cut: el.scrollWidth > el.clientWidth, title: el.getAttribute('title'), text: el.textContent.trim() }));
    check(longRow.height <= longRow.lineHeight * 1.1 && longRow.cut && longRow.overflow === 'ellipsis', `R4.1 ${mode.name}: a Review group finding whose summary is longer than its row stays on one line and is cut with an ellipsis (height ${longRow.height} of a ${longRow.lineHeight} line, cut ${longRow.cut}, text-overflow ${longRow.overflow})`);
    check(longRow.title === longRow.text, `R4.1 ${mode.name}: the cut finding row carries its full summary as its title (${JSON.stringify(longRow.title)})`);
    const cut = await cutOff();
    check(cut.length === 0, `R14.2 ${mode.name}: nothing in the task list is cut off${cut.length ? ` (${cut.join('; ')})` : ''}`);
    // The list scrolls on its own, down to the last finding row, with nothing else moving.
    // Overview shows the whole folded list inside its room; the narrower strip of Watch overflows, and its end is the last finding row.
    if (mode.key === 2) await scrollsOnItsOwn(`tasks with the review (${mode.name})`, tasksBody, '.k-bp__heading, [data-fold], [data-task], [data-finding-row], [data-low-fold]');
  });
}

// R1.1 findings and departures, R1.2 findings: switch to another mode and back.
  await attempt('R1.1 and R1.2 findings', async () => {
    await enter(MODES[3]);
    const read = await findingsBody.innerText();
    check(/upload limit is duplicated/.test(read) && /Medium/.test(read), `the review's findings are read on the build page (${JSON.stringify(read.replace(/\s+/g, ' ').slice(0, 120))})`);
    await scrollsOnItsOwn('findings', findingsBody, '.k-findings__item');
    const findingsBefore = await scrollPartWay(findingsBody);
    await page.keyboard.press('Control+1');
    await settle();
    await page.keyboard.press('Control+4');
    await settle();
    keptPlace('findings', findingsBefore, await placeOf(findingsBody));
  });
  await stays('the findings read');

  // R1.1 tasks: Overview, the Done filter's list (finished tasks fold at All, so each on its own line is what overflows) once the build and its review are finished.
  await attempt('R1.1 tasks', async () => {
    await enter(MODES[0]);
    // Finished tasks fold into one line per repository, so the list that overflows is the Done filter's: each finished task on its own line.
    await filterTo('Done');
    await scrollsOnItsOwn('tasks', tasksBody, '.k-bp__heading, [data-task]');
  });

  // R1.2 tasks: flip to another area in the same stack and back.
  await attempt('R1.2 tasks', async () => {
    await enter(MODES[1]);
    await page.locator('[data-rail]').getByRole('button', { name: /^Bring back Changed files/ }).click();
    await settle();
    await area('tasks').getByRole('button', { name: 'Place Tasks' }).click();
    await page.getByRole('menuitem', { name: 'Right' }).click();
    await settle();
    const stack = { getByRole: (...a) => page.locator('[data-area]:not([inert]) [role="tablist"]').first().getByRole(...a) };
    await stack.getByRole('tab', { name: /^Tasks/ }).click();
    await settle();
    const tasksBefore = await scrollPartWay(tasksBody);
    await stack.getByRole('tab', { name: /^Changed files/ }).click();
    await settle();
    await stack.getByRole('tab', { name: /^Tasks/ }).click();
    await settle();
    keptPlace('tasks', tasksBefore, await placeOf(tasksBody));
    await filterTo('All');
  });
  // R5.4 and R7.1: the round dialog's findings picker fits the window, says which agents start, and starts one agent per repository at once.
  await attempt('the round dialog', async () => {
    await enter(MODES[3]);
    await barButtonOf('Another round').click();
    const round = page.getByRole('dialog');
    await round.getByRole('button', { name: /^Start run$/ }).waitFor();
    await eventually(page, () => round.locator('[data-finding]').count(), (n) => n > 0, 'the round listing the findings');
    const box = await round.boundingBox();
    check(box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 800, `the round dialog fits inside 1280 by 800 (${JSON.stringify(box)})`);
    check((await round.getByRole('checkbox').count()) > 0, 'the round dialog lists the findings with a checkbox each');
    check((await round.locator('[data-finding]').filter({ has: page.getByText('Fixed in') }).count()) === 1, 'the finding that names no repository offers a Fixed in choice, and only that one');
    const longItem = await round.locator('[data-finding]', { hasText: 'photo count is read twice' }).getByText('photo count is read twice').evaluate((el) => ({ height: el.clientHeight, lineHeight: parseFloat(getComputedStyle(el).lineHeight) || el.clientHeight, overflow: getComputedStyle(el).textOverflow, cut: el.scrollWidth > el.clientWidth, title: el.getAttribute('title'), text: el.textContent.trim() }));
    check(longItem.height <= longItem.lineHeight * 1.1 && longItem.cut && longItem.overflow === 'ellipsis', `the round dialog keeps a long finding summary on one line, cut with an ellipsis (height ${longItem.height} of a ${longItem.lineHeight} line, cut ${longItem.cut}, text-overflow ${longItem.overflow})`);
    check(longItem.title === longItem.text, 'the round dialog gives the cut summary its full text as a title');
    const summary = round.locator('[data-round-summary]');
    // The finding without a repository blocks the round until the engineer says where it is fixed.
    check(/Choose a repository/.test(await summary.innerText()), 'the round says a finding without a repository needs a Fixed in choice before it can start');
    await round.locator('[aria-label="Fixed in, for F5"]').first().click();
    await page.getByRole('option', { name: 'customer-portal' }).click();
    check((await round.getByRole('checkbox').count()) >= 2, 'the round lists a checkbox for each finding');
    await eventually(page, () => summary.innerText(), (t) => /Starts [0-9]+ agents?/.test(t) && /commerce-core/.test(t) && /customer-portal/.test(t), 'the summary naming the agents');
    check(true, 'R5.4 the round says which agents will start, with commerce-core and customer-portal among them');
    check(await inWindow(summary), 'the round summary is inside the window');
    // Escape closes the dialog and the page behind it is still the build page.
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await stays('the round dialog closed');
    await barButtonOf('Another round').click();
    await round.getByRole('button', { name: /^Start run$/ }).waitFor();
    await round.locator('[aria-label="Fixed in, for F5"]').first().click();
    await page.getByRole('option', { name: 'customer-portal' }).click();
    await eventually(page, () => round.getByRole('button', { name: /^Start run$/ }).isEnabled(), (on) => on, 'the round being ready to start');
    await round.getByRole('button', { name: /^Start run$/ }).click();
    // R7.1: both repositories have their agent running together, neither waiting for the other.
    await eventually(
      page,
      () => page.evaluate(() => [...document.querySelectorAll('[data-group]')].filter((g) => [...g.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Cancel')).length),
      (n) => n >= 2,
      'two repositories running at once',
      20000,
    );
    check(true, 'R7.1 an agent runs in each of two repositories at the same time');
    await stays('the round started');
    // The round ends by itself. Its commits are not reviewed yet, so the bar offers Run review; the review is what lets the change be declared done.
    await eventually(page, () => barButtonOf('Cancel build').count(), (n) => n === 0, 'the round ending', 90000);
    await barButtonOf('Run review').click();
    await page.getByRole('dialog').getByRole('button', { name: /^Start run$/ }).click();
    await eventually(page, () => barButtonOf('Run review').count(), (n) => n === 0, 'the review of the round starting', 20000);
    await eventually(page, () => barButtonOf('Cancel build').count(), (n) => n === 0, 'the review of the round ending', 90000);
    await declare.waitFor({ timeout: 90000 });
  });
  if ((await page.getByRole('dialog').count()) > 0) await page.keyboard.press('Escape');

  // R5.1 and R9.2: the largest a separator goes leaves the middle its minimum with the rails drawn (the room is the grid less its rails and separators).
  await attempt('R5.1 the left separator with a rail', async () => {
    await enter(MODES[3]);
    check((await page.locator('[data-rail="right"]').count()) === 1, 'Review has areas tucked at the right rail');
    await page.locator('[role="separator"][data-side="left"]').focus();
    await page.keyboard.press('End');
    await settle();
    const middle = await area('files').boundingBox();
    check(middle !== null && middle.width >= 240 - 0.5, `R5.1 Review: after End on the left separator the middle is at least 240 wide (${Math.round(middle?.width ?? 0)})`);
  });
  // The tasks strip below 240 pixels draws its tasks compact: the status dot stays, the label leaves the screen but not the accessibility tree.
  await attempt('the tasks strip draws compact below 240 pixels', async () => {
    await enter(MODES[1]);
    await filterTo('Done');
    const row = tasksBody.locator('[data-task]').first();
    const dot = row.locator('.k-status__dot');
    const label = row.locator('.k-bp__status-label');
    const separator = page.locator('[role="separator"][data-side="left"]');
    await separator.focus();
    await page.keyboard.press('Home');
    await settle();
    const narrow = await area('tasks').boundingBox();
    check(narrow !== null && narrow.width < 240, `Watch: Home on the tasks separator makes the strip narrower than 240 (${Math.round(narrow?.width ?? 0)})`);
    check(await dot.isVisible(), 'Watch: in a strip under 240 wide a task keeps its status dot');
    const hidden = await label.boundingBox();
    check(!(await label.isVisible()) && (hidden === null || (hidden.width < 1 && hidden.height < 1)), `Watch: in a strip under 240 wide a task shows no status label (${JSON.stringify(hidden)})`);
    const labelText = ((await label.textContent()) ?? '').trim();
    check(labelText !== '' && (await row.ariaSnapshot()).includes(labelText), `Watch: the compact task still exposes its status to assistive tech (${JSON.stringify(labelText)})`);
    await separator.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await settle();
    const wide = await area('tasks').boundingBox();
    check(wide !== null && wide.width >= 240, `Watch: widening the strip brings it to 240 or more (${Math.round(wide?.width ?? 0)})`);
    check(await label.isVisible(), 'Watch: in a strip of 240 or more a task shows its status label again');
    await filterTo('All');
    await enter(MODES[1]);
  });
  await attempt('R5.1 the bottom separator with a rail', async () => {
    await enter(MODES[2]);
    await page.locator('[data-rail]').getByRole('button', { name: /^Bring back Tasks/ }).click();
    await settle();
    await area('tasks').getByRole('button', { name: 'Place Tasks' }).click();
    await page.getByRole('menuitem', { name: 'Bottom' }).click();
    await settle();
    await area('tasks').getByRole('button', { name: 'Tuck Tasks away' }).click();
    await settle();
    check((await page.locator('[data-rail="bottom"]').count()) === 1, 'Changes has an area tucked at the bottom rail');
    await page.locator('[role="separator"][data-side="bottom"]').focus();
    await page.keyboard.press('End');
    await settle();
    const row = await area('files').boundingBox();
    check(row !== null && row.height >= 280 - 0.5, `R5.1 Changes: after End on the bottom separator the row above the bottom is at least 280 high (${Math.round(row?.height ?? 0)})`);
    await enter(MODES[2]);
  });

  // Declare done opens its dialog on the same page; opening the pull requests lists them there too.
  await declare.click();
  const doneDialog = page.getByRole('dialog');
  await doneDialog.getByRole('button', { name: 'Open pull requests' }).waitFor();
  // The long review has high findings, so the pull requests wait for the engineer to accept them as unresolved.
  const unresolved = doneDialog.getByRole('checkbox', { name: /unresolved/ });
  if ((await unresolved.count()) > 0) await unresolved.click();
  await stays('done declared');
  await doneDialog.getByRole('button', { name: 'Open pull requests' }).click();
  const prs = page.getByRole('dialog').filter({ hasText: 'github.com/acme/' });
  await prs.waitFor();
  const listedPrs = await prs.innerText();
  const pulls = (listedPrs.match(/github\.com\/acme\/[\w-]+\/pull\/\d+/g) ?? []).length;
  check(pulls === REPOS.length + 1 && !/failed/i.test(listedPrs), `pull requests opened for all ${REPOS.length + 1} repositories (${pulls} listed)`);
  await prs.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const tab = await eventually(page, () => buildTab.innerText(), (t) => /done/.test(t), 'the Build tab saying done').catch((e) => e.message);
  check(/done/.test(tab), `the Build tab says the change is done (${JSON.stringify(tab)})`);
  await stays('pull requests opened');
  check((await countOf('[data-bar] .k-bp__actions button')) === 0, 'a done change offers no action in the bar');

  check(errors.length === 0, `no page error, console error or failed request${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await close();
}

// R15.1: with a dialog open the way back cannot be reached until the dialog is closed. A second page, since the first one is inside a finished build.
{
  const second = await open({ width: 1280, height: 800 });
  const p = second.page;
  const back = p.locator('button[aria-label="Back to the changes list"]');
  try {
    await back.waitFor();
    check(await back.isEnabled(), 'the way back is reachable with no dialog open');
    await p.getByRole('button', { name: 'Start build' }).click();
    const preview = p.getByRole('dialog');
    await preview.getByRole('button', { name: /^Start run$/ }).waitFor();
    const blocked = await back.click({ trial: true, timeout: 1500 }).then(() => false, () => true);
    check(blocked, 'with the run preview open a click on the way back cannot land');
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await p.keyboard.press('Tab');
      reached = await back.evaluate((el) => el === document.activeElement);
    }
    check(!reached, 'with the run preview open Tab never reaches the way back (the dialog traps focus)');
    check(new URL(p.url()).pathname === ROUTE, 'the page is still on the change with the dialog open');
    await p.keyboard.press('Escape');
    await p.getByRole('dialog').waitFor({ state: 'detached' });
    const clickable = await back.click({ trial: true, timeout: 3000 }).then(() => true, () => false);
    check(clickable, 'once the run preview is closed the way back can be clicked again');
    await back.click();
    await eventually(p, () => new URL(p.url()).pathname, (path) => path === '/sdlc', 'the way back leaving the change');
    check(true, 'the way back leads to the changes list');
    check(second.errors.length === 0, `no page error, console error or failed request${second.errors.length ? `: ${second.errors.join(' | ')}` : ''}`);
  } finally {
    await second.close();
  }
}
done();
