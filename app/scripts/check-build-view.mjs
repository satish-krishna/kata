// The build page in a real browser (`npm run check:build`; run `npm run build` first).
//
// Drives the mock's scripted build of two repositories (`claims-core` and `customer-portal` run together,
// `customer-portal` asks one question) on the production build, all on the change page's Build tab:
//   1. From the plan accepted to the pull requests opened on one page: start the build, answer `customer-portal`'s
//      question while the changed files are in view, let the review finish, read the findings, declare done and open
//      the pull requests. At every step the URL stays on the change, the Build tab stays selected and no `app-build-view` exists.
//   2. At 375, 768, 1024 and 1280 pixels there is no horizontal page scroll, every area (tasks, activity, files) can be
//      reached (side by side from 1024, through the page's area switch below), and the bar's actions and the waiting notice stay in view.
//   3. With the run preview open the way back to the changes list cannot be reached, and once it closes it can.
import { BUILD_WIDTHS, ROUTE, eventually, noHorizontalScroll, open, reporter, startBuild } from './check-build-support.mjs';

const { check, done } = reporter('check:build');
const { page, errors, close } = await open();

const AREAS = ['tasks', 'activity', 'files'];
const SWITCH = { tasks: 'Tasks', activity: 'Activity', files: 'Files' };
const area = (name) => page.locator(`[data-area="${name}"]`);
const notices = page.locator('[data-waiting]:visible');
// By CSS, not by role: an open dialog hides the page from the accessibility tree, and the page must be checked behind it too.
const buildTab = page.locator('[role="tab"]', { hasText: /^Build/ });
const countOf = (sel) => page.locator(sel).count();

/** R10.2: the engineer never leaves the build page and never sees another build screen. */
async function stays(step) {
  const url = new URL(page.url()).pathname;
  const tab = await buildTab.getAttribute('aria-selected');
  const old = await countOf('app-build-view');
  const pages = await countOf('app-build-page');
  check(url === ROUTE && tab === 'true' && old === 0 && pages === 1, `${step}: still on ${ROUTE} with the Build tab selected, one build page and no app-build-view (${url}, selected ${tab}, build views ${old}, build pages ${pages})`);
}

/** Whether the element is visible and wholly inside the window. */
const inWindow = (locator) =>
  locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.checkVisibility() && r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5;
  });

try {
  await stays('plan accepted');
  await startBuild(page);
  await stays('the build started');

  // While a run goes, its observe pane scrolls its own events; the area around it must not scroll as well.
  await area('activity').waitFor();
  for (const height of [900, 700]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(300);
    const panel = await area('activity').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    check(panel.scroll <= panel.client + 1, `1280x${height}: one running build, the Activity area has no scrollbar of its own (${panel.scroll} of ${panel.client})`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // R16.2: stopping a repository and continuing it discards nothing. The uncommitted file is listed before and after.
  const uncommitted = () => countOf('[data-area="files"] [data-file="src/limits.rs"]');
  const listed = await uncommitted();
  // R12.1: Continue on one stopped repository opens its preview first; it must fit at 375 without a horizontal scroll.
  await page.locator('[data-group]', { hasText: 'claims-core' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Continue claims-core' }).waitFor();
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('radiogroup', { name: 'Build areas' }).getByRole('radio', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'Continue claims-core' }).click();
  const preview = page.getByRole('dialog');
  await preview.getByRole('button', { name: /^Start run$/ }).waitFor();
  await eventually(page, () => preview.getByRole('button', { name: /^Start run$/ }).isEnabled(), (on) => on, 'the continue preview resolving');
  const box = await preview.boundingBox();
  const narrow = await noHorizontalScroll(page);
  check(box !== null && box.x >= 0 && box.x + box.width <= 375, `the continue preview fits inside 375 pixels (${JSON.stringify(box)})`);
  check(narrow.scrollWidth <= narrow.clientWidth && narrow.body <= narrow.clientWidth, `375px: the continue preview leaves no horizontal page scroll (${narrow.scrollWidth} of ${narrow.clientWidth})`);
  check((await preview.innerText()).includes('No push'), 'the continue preview lists the safety rules');
  await page.setViewportSize({ width: 1280, height: 900 });
  await preview.getByRole('button', { name: /^Start run$/ }).click();
  await stays('claims-core stopped and continued');

  // R4.2: the question is told at once, pinned above the areas, while the changed files are in view.
  await notices.first().waitFor();
  const text = await notices.first().innerText();
  check(text.includes('customer-portal') && text.includes('answer'), `the notice names customer-portal and what it waits for (${JSON.stringify(text.replace(/\s+/g, ' '))})`);
  check(/stops if nobody answers within \d+:\d+/.test(text), 'the notice says how long the run will wait');
  check((await area('files').isVisible()) && (await countOf('[data-area="files"] [data-file]')) > 0, 'the changed files are in view while the question waits');
  check(await inWindow(notices.first()), 'the waiting notice is inside the window beside the changed files');
  const after = await uncommitted();
  check(after === listed && listed > 0, `stopping and continuing a repository discarded no file (src/limits.rs listed ${listed} -> ${after})`);
  await stays('the question waits');

  // R12.1: the width pass, with the question waiting. Reaching an area means it is on show with room, not that it is in the DOM.
  for (const width of BUILD_WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    const scroll = await noHorizontalScroll(page);
    check(scroll.scrollWidth <= scroll.clientWidth && scroll.body <= scroll.clientWidth, `${width}px: no horizontal page scroll (${scroll.scrollWidth} of ${scroll.clientWidth})`);
    const barActions = page.locator('[data-bar] .k-bp__actions button');
    check((await barActions.count()) > 0, `${width}px: the bar has its actions`);
    const reach = async (where) => {
      for (const b of await barActions.all()) check(await inWindow(b), `${width}px (${where}): the bar action "${(await b.innerText()).trim()}" is inside the window`);
      check(await inWindow(notices.first()), `${width}px (${where}): the waiting notice is inside the window`);
      check(await inWindow(notices.first().getByRole('button', { name: 'Go to customer-portal' })), `${width}px (${where}): the notice's Go to customer-portal is inside the window`);
    };
    const areaSwitch = page.getByRole('radiogroup', { name: 'Build areas' });
    if (width >= 1024) {
      check((await areaSwitch.count()) === 0, `${width}px: no area switch, the areas sit side by side`);
      const boxes = [];
      for (const name of AREAS) boxes.push({ name, box: await area(name).boundingBox() });
      const shown = boxes.every(({ box }) => box !== null && box.width > 100 && box.height > 100);
      const ordered = shown && boxes.every(({ box }, i) => i === 0 || box.x >= boxes[i - 1].box.x + boxes[i - 1].box.width - 1) && boxes.every(({ box }) => box.y === boxes[0].box.y);
      check(ordered, `${width}px: tasks, activity and files sit side by side (${JSON.stringify(boxes.map(({ name, box }) => [name, Math.round(box?.x ?? -1), Math.round(box?.width ?? 0)]))})`);
      await reach('side by side');
    } else {
      check(await areaSwitch.isVisible(), `${width}px: the area switch shows`);
      for (const name of AREAS) {
        await areaSwitch.getByRole('radio', { name: SWITCH[name] }).click();
        const only = (v) => v.every(([other, visible]) => visible === (other === name));
        const states = await eventually(page, () => Promise.all(AREAS.map(async (other) => [other, await area(other).isVisible()])), only, `${name} alone on show at ${width}`).catch(() => Promise.all(AREAS.map(async (other) => [other, await area(other).isVisible()])));
        const box = await area(name).boundingBox();
        check(only(states) && box !== null && box.width > 200 && box.x >= 0 && box.x + box.width <= width + 0.5, `${width}px: the switch reaches ${name} alone and it fits (${JSON.stringify(states)}, width ${Math.round(box?.width ?? 0)})`);
        if (name === 'files') check((await countOf('[data-area="files"] [data-file]')) > 0, `${width}px: the changed files can be read on Files`);
        if (name === 'tasks') check((await countOf('[data-area="tasks"] [data-task]')) > 0, `${width}px: the tasks can be read on Tasks`);
        await reach(`on ${name}`);
        const again = await noHorizontalScroll(page);
        check(again.scrollWidth <= again.clientWidth && again.body <= again.clientWidth, `${width}px: no horizontal page scroll on ${name} (${again.scrollWidth} of ${again.clientWidth})`);
      }
      // Every run keeps folding events while its area is hidden, so a hidden run's question is never missed.
      const runs = await countOf('[data-session]');
      check(runs >= 2 && (await countOf('[data-pane]')) >= 2, `${width}px: every run's pane stays mounted while its area is hidden (${runs} runs)`);
    }
    await stays(`${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);

  // Answer from the pinned notice with the changed files still in view.
  await notices.first().getByRole('button', { name: 'Go to customer-portal' }).click();
  await page.locator('label', { hasText: 'Reuse it' }).waitFor();
  check(await area('files').isVisible(), 'the changed files stay in view while the question is answered');
  await page.locator('label', { hasText: 'Reuse it' }).click();
  await page.getByRole('button', { name: /Send answer/ }).click();
  await eventually(page, () => notices.count(), (n) => n === 0, 'the notice going away');
  check(true, 'answering clears the notice');
  await stays('the question answered');

  // The build finishes by itself: three tasks in the build log, the review run, and the bar offers Declare done.
  const tasks = () => page.locator('[data-bar] .k-lock__count').innerText();
  const finished = await eventually(page, tasks, (t) => t.startsWith('3/3'), 'every task reaching the build log', 20000).catch((e) => e.message);
  check(String(finished).startsWith('3/3'), `all three tasks are in the build log (${JSON.stringify(finished)})`);
  const declare = page.locator('[data-bar]').getByRole('button', { name: 'Declare done' });
  await declare.waitFor({ timeout: 30000 });
  check(await inWindow(declare), 'Declare done is in the bar once the build and its review are finished');
  await stays('the review finished');

  // Read the findings: pick Review and the findings list replaces the run.
  const review = page.locator('[data-review]');
  const status = await eventually(page, () => review.locator('xpath=..').innerText(), (t) => /Finished/.test(t), 'the review finishing').catch((e) => e.message);
  check(/Finished/.test(status), `the review entry reads Finished (${JSON.stringify(String(status).replace(/\s+/g, ' '))})`);
  await review.click();
  const findings = area('activity').locator('app-findings-list');
  await findings.waitFor();
  const read = await findings.innerText();
  check(/upload limit is duplicated/.test(read) && /Medium/.test(read), `the review's findings are read on the build page (${JSON.stringify(read.replace(/\s+/g, ' ').slice(0, 120))})`);
  await stays('the findings read');

  // Declare done opens its dialog on the same page; opening the pull requests lists them there too.
  await declare.click();
  const doneDialog = page.getByRole('dialog');
  await doneDialog.getByRole('button', { name: 'Open pull requests' }).waitFor();
  await stays('done declared');
  await doneDialog.getByRole('button', { name: 'Open pull requests' }).click();
  const prs = page.getByRole('dialog').filter({ hasText: 'github.com/acme/customer-portal/pull/' });
  await prs.waitFor();
  const listedPrs = await prs.innerText();
  const pulls = (listedPrs.match(/github\.com\/acme\/[\w-]+\/pull\/\d+/g) ?? []).length;
  check(pulls === 3 && !/failed/i.test(listedPrs), `pull requests opened for all three repositories (${pulls} listed)`);
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
  const second = await open();
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
