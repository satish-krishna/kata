// The build view in a real browser (`npm run check:build`; run `npm run build` first).
//
// Drives the mock's scripted build of two repositories (`claims-core` and `customer-portal`
// run together, `customer-portal` asks one question) and checks, on the production build:
//   - while the engineer is on Changes, the drawer holds the changed files, the waiting notice names
//     `customer-portal`, the Changes tab stays selected, and `claims-core`'s events keep arriving;
//   - Go to customer-portal moves to its run, answering clears the notice, and the run carries on;
//   - at 375, 768 and 1280 pixels the build view has no horizontal page scroll and the
//     repository list stacks above the main column below 768.
import { MD, WIDTHS, eventually, noHorizontalScroll, open, reporter, startBuild } from './check-build-support.mjs';

const { check, done } = reporter('check:build');
const { page, errors, close } = await open();

const selected = (name) => page.getByRole('tab', { name }).getAttribute('aria-selected');
// On Changes the drawer holds the file list, not the repository rows: what is on show is the Activity tab's
// "N new" count (events that arrived in Activity since the engineer last looked) and the task count in the bar.
const activityNew = async () => Number(/(\d+) new/.exec(await page.getByRole('tab', { name: /^Activity/ }).innerText())?.[1] ?? 0);
const tasksDone = async () => Number(/^(\d+)\//.exec(await page.locator('.k-build__top .k-lock__count').innerText())?.[1] ?? 0);
const rowText = (repo) => page.locator('.k-repos__row', { hasText: repo }).innerText();
const notices = page.locator('[data-waiting]:visible');

try {
  await startBuild(page);

  // While a run goes, its observe pane scrolls its own events; the panel around it must not scroll as well.
  await page.getByRole('tab', { name: /^Activity/ }).click();
  for (const height of [900, 700]) {
    await page.setViewportSize({ width: 1280, height });
    await page.waitForTimeout(300);
    const panel = await page.evaluate(() => {
      const el = document.querySelector('.k-build__panel:not([hidden])');
      return { scroll: el.scrollHeight, client: el.clientHeight };
    });
    check(panel.scroll <= panel.client + 1, `1280x${height}: one running build, the Activity panel has no scrollbar of its own (${panel.scroll} of ${panel.client})`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // R12.1: Continue on one stopped repository opens its preview first; it must fit at 375 without a horizontal scroll.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Continue claims-core' }).waitFor();
  await page.setViewportSize({ width: 375, height: 900 });
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

  await page.getByRole('tab', { name: 'Changes' }).click();

  // R17.5: told at once, on Changes, and the engineer stays there.
  await notices.first().waitFor();
  const text = await notices.first().innerText();
  check(text.includes('customer-portal') && text.includes('answer'), `the notice names customer-portal and what it waits for (${JSON.stringify(text.replace(/\s+/g, ' '))})`);
  check(/stops if nobody answers within \d+:\d+/.test(text), 'the notice says how long the run will wait');
  check((await selected('Changes')) === 'true', 'the Changes tab is still selected while the notice shows');

  // R17.2: claims-core's events kept arriving while the engineer looked at Changes.
  check((await page.locator('#build-repos [data-file]').count()) > 0 && (await page.locator('#build-repos .k-repos__row').count()) === 0, 'on Changes the drawer holds the changed files, not the repository rows');
  const before = await activityNew();
  const after = await eventually(page, activityNew, (n) => n > before, 'claims-core events arriving').catch(() => activityNew());
  check(after > before, `claims-core's events kept arriving while on Changes (Activity tab ${before} -> ${after} new)`);
  // claims-core has the one task customer-portal does not wait on; it is logged when claims-core finishes.
  const done1 = await eventually(page, tasksDone, (n) => n >= 1, 'claims-core finishing').catch(() => tasksDone());
  check(done1 >= 1, `claims-core ran on to finished while the engineer stayed on Changes (${done1} task(s) in the build log)`);
  check((await selected('Changes')) === 'true' && (await notices.count()) > 0, 'still on Changes with the notice showing after the other repository finished');

  // Go to the waiting repository, answer, and the notice is gone while the run carries on.
  await notices.first().getByRole('button', { name: 'Go to customer-portal' }).click();
  const onActivity = await eventually(page, () => selected('Activity'), (v) => v === 'true', 'switching to Activity').catch(() => 'false');
  check(onActivity === 'true', 'Go to customer-portal switches to Activity');
  const head = await eventually(page, () => page.locator('.k-build__repo-head h2').innerText(), (v) => v === 'customer-portal', 'selecting customer-portal').catch((e) => e.message);
  check(head === 'customer-portal', `customer-portal is the selected repository (${head})`);
  await page.locator('label', { hasText: 'Reuse it' }).click();
  await page.getByRole('button', { name: /Send answer/ }).click();
  await eventually(page, () => notices.count(), (n) => n === 0, 'the notice going away');
  check(true, 'answering clears the notice');
  await page.getByRole('tab', { name: 'Changes' }).click();
  check((await notices.count()) === 0, 'no notice on Changes either');
  // The rows are in the drawer on Activity.
  await page.getByRole('tab', { name: /^Activity/ }).click();
  const finished = await eventually(page, () => rowText('customer-portal'), (t) => /Finished/.test(t), 'customer-portal finishing', 15000).catch((e) => e.message);
  check(/Finished/.test(String(finished)), `customer-portal carried on to its row (${JSON.stringify(String(finished).replace(/\s+/g, ' '))})`);
  check((await page.locator('.k-build__top .k-lock__count').innerText()).startsWith('3/3'), 'all three tasks are in the build log');
  check((await page.locator('.k-build__bar .k-build__top').count()) === 1, 'the task count sits in the bar, outside the repository list');

  // The repository list collapses to nothing and comes back, and its edge drags.
  await page.getByRole('tab', { name: 'Activity' }).click();
  const listWidth = () => page.evaluate(() => Math.round(document.querySelector('#build-repos').getBoundingClientRect().width));
  const open = await listWidth();
  await page.getByRole('button', { name: 'Hide repositories' }).click();
  const shut = await eventually(page, listWidth, (w) => w === 0, 'the list collapsing').catch(() => listWidth());
  check(shut === 0, `Hide repositories collapses the list (${open}px -> ${shut}px)`);
  await page.getByRole('button', { name: 'Show repositories' }).click();
  const back = await eventually(page, listWidth, (w) => w === open, 'the list coming back').catch(() => listWidth());
  check(back === open, `Show repositories brings it back at its width (${back}px of ${open}px)`);
  const handle = await page.getByRole('separator', { name: 'Resize the repository list' }).boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, handle.y + handle.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = await eventually(page, listWidth, (w) => w > open + 60, 'the list widening').catch(() => listWidth());
  check(dragged > open + 60, `dragging the edge widens the list (${open}px -> ${dragged}px)`);

  // Widths.
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await eventually(
      page,
      () =>
        page.evaluate(() => {
          const rect = (sel) => document.querySelector(sel)?.getBoundingClientRect();
          const left = rect('.k-build__left');
          const main = rect('.k-build__main');
          return { stacked: left.bottom <= main.top + 1, beside: left.right <= main.left + 1 };
        }),
      (l) => (width < MD ? l.stacked : l.beside),
      `build layout at ${width}`,
    ).catch((e) => ({ error: e.message }));
    const sideways = await page.evaluate(() =>
      [...document.querySelectorAll('.k-build *')]
        .filter((el) => el.checkVisibility() && el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX))
        .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${el.scrollWidth} of ${el.clientWidth}`),
    );
    check(sideways.length === 0, `${width}px: nothing in the build view scrolls sideways${sideways.length ? ` (${sideways.join(' | ')})` : ''}`);
    // The finished build's findings sit above the runs here, so the panel may scroll; the latest pane still runs to the
    // bottom of the panel's content, with no empty space left under it.
    const fill = await page.evaluate(() => {
      const panel = document.querySelector('.k-build__panel:not([hidden])');
      panel.scrollTop = panel.scrollHeight;
      const last = [...document.querySelectorAll('.k-build__runs:not([hidden]) .k-build__pane')].at(-1);
      const pad = parseFloat(getComputedStyle(panel).paddingBottom);
      return { gap: Math.round(panel.getBoundingClientRect().bottom - pad - last.getBoundingClientRect().bottom), pane: Math.round(last.getBoundingClientRect().height) };
    });
    check(Math.abs(fill.gap) <= 2, `${width}px: the last run's observe pane reaches the bottom of the panel (${fill.gap}px short, ${fill.pane}px tall)`);
    const scroll = await noHorizontalScroll(page);
    check(scroll.scrollWidth <= scroll.clientWidth && scroll.body <= scroll.clientWidth, `${width}px: no horizontal page scroll (${scroll.scrollWidth} of ${scroll.clientWidth})`);
    if (layout.error) check(false, layout.error);
    else check(true, width < MD ? `${width}px: the repository list stacks above the main column` : `${width}px: the repository list sits beside the main column`);
  }

  check(errors.length === 0, `no page error, console error or failed request${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await close();
}
done();
