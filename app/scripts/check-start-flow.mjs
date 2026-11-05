// The light track in a real browser (`node scripts/check-start-flow.mjs`; run `npm run build` first).
//
// The fix change routes and the new controls the light track added, on the production build and under the desktop CSP, with the mock's
// plugin reporting 0.13.0 (so the Track field, the fix actions and the instructions row show):
//   1. Boot: a fix awaiting acceptance and a rejected fix render without a runtime error, each with the fix tag and a status word (R14.1).
//   2. Interaction: the fix's "Change the fix" feedback box opens and closes; New change opens, switches Track and closes; the
//      instructions row's button opens the run preview and it cancels (R14.1).
//   3. `?demo=start`: the scripted triage prints a light-track verdict, asks with the three fixed choices, and on "Take the light track"
//      ends with the fix folder created, so the page lands on the new fix (R2.1).
// The same routes are listed in `check:boot` and `check:interaction` when the owner adds them to package.json, which the app/ guard
// keeps an agent from editing; this script runs them in the meantime.
import { open, reporter } from './check-build-support.mjs';

const { check, done } = reporter('check-start-flow');

const FIX = '/sdlc/commerce/2026-10-22-photo-retry-fix';
const REJECTED = '/sdlc/commerce/2026-10-21-limit-typo-fix';
const STARTED_FIX = '/sdlc/commerce/2026-10-24-price-flag-fix';

const { page, origin, errors, close } = await open({ width: 1600, height: 1000 });
page.setDefaultTimeout(8000);
const go = async (path) => {
  await page.goto(origin + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
};
const dialog = page.getByRole('dialog');
const visibleCount = (loc) => loc.count();
/** True when the locator shows up within the default timeout. */
const appears = async (loc) => {
  try {
    await loc.first().waitFor({ state: 'visible' });
    return true;
  } catch {
    return false;
  }
};
const gone = async (loc) => {
  try {
    await loc.first().waitFor({ state: 'hidden' });
    return true;
  } catch {
    return false;
  }
};

try {
  // 1. Boot
  await go(FIX);
  check(await appears(page.locator('[data-testid="track-tag"]')), 'the fix awaiting acceptance shows the fix tag');
  check(await appears(page.getByText('Fix · awaiting acceptance').first()), 'the fix awaiting acceptance says so with a status word');
  check((await visibleCount(page.getByRole('button', { name: 'Accept fix' }))) === 1, 'the fix offers Accept fix');
  check((await visibleCount(page.getByRole('button', { name: /^(Accept intent|Start spec|Accept plan|Start plan)$/ }))) === 0, 'the fix offers no full-pipeline document action');
  await go(REJECTED);
  check(await appears(page.locator('[data-testid="track-tag"]')), 'the rejected fix shows the fix tag');
  check(await appears(page.getByText('Closed · rejected').first()), 'the rejected fix says it is closed');

  // 2. Interaction
  await go(FIX);
  await page.getByRole('button', { name: 'Change the fix' }).click();
  check(await appears(dialog.locator('textarea')), 'Change the fix opens the feedback box');
  await page.keyboard.press('Escape');
  check(await gone(dialog), 'the feedback box closes on Escape');

  await go('/sdlc');
  await page.getByRole('button', { name: /New change/ }).click();
  check(await appears(dialog), 'New change opens');
  const decide = dialog.getByRole('radio', { name: 'Let the workflow decide' });
  const full = dialog.getByRole('radio', { name: 'Full pipeline' });
  check(await appears(decide), 'New change offers the Track field');
  check(await decide.isEnabled(), 'the workflow can decide with the light-track plugin');
  await full.click();
  await page.waitForTimeout(200);
  check((await full.getAttribute('aria-checked')) === 'true', 'Track switches to Full pipeline');
  await decide.click();
  await page.waitForTimeout(200);
  check((await decide.getAttribute('aria-checked')) === 'true', 'Track switches back to Let the workflow decide');

  // A click outside and Escape leave New change open with its text, typed or not (R13.1).
  const idea = dialog.getByRole('textbox', { name: 'Description' });
  const stray = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const afterEscape = await visibleCount(dialog);
    await page.mouse.click(5, 5);
    await page.waitForTimeout(300);
    return [afterEscape, await visibleCount(dialog)];
  };
  check((await stray()).join() === '1,1', 'Escape and a click outside leave New change open with nothing typed');
  await idea.fill('flag suspicious prices');
  check((await stray()).join() === '1,1' && (await idea.inputValue()) === 'flag suspicious prices', 'Escape and a click outside leave New change open with its text');

  // Escape closes a list opened inside the dialog and not the dialog (R13.2). The mock's workspace has one system, so the list is the work type.
  const listTrigger = dialog.getByRole('combobox').first();
  check(await appears(listTrigger), 'New change offers a list to open');
  await listTrigger.click();
  const option = page.getByRole('option').first();
  check(await appears(option), 'the list inside New change opens');
  await page.keyboard.press('Escape');
  check(await gone(option), 'Escape closes the list');
  check((await visibleCount(dialog)) === 1 && (await idea.inputValue()) === 'flag suspicious prices', 'the dialog stays open with everything as typed after Escape closed the list');

  // Cancel closes without asking, and the next open is empty (R14.1). It replaces the Escape this step used to close with.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  check(await gone(dialog), 'New change closes on Cancel');
  check((await visibleCount(page.getByText('Stop everything that is running and close?'))) === 0, 'Cancel asks no question');
  await page.getByRole('button', { name: /New change/ }).click();
  check(await appears(idea), 'New change opens again');
  check((await idea.inputValue()) === '', 'the next New change opens with an empty description');

  // Closing the window with text typed adds no question of its own (R15.1). The browser cannot close a window: the mock records the
  // close answer and nothing more, and asks only under ?demo=close, so "nothing runs" is shown as no close question on screen with
  // text typed, and "a change runs" under ?demo=close with New change opened beside the close question, which names the running changes once.
  await idea.fill('flag suspicious prices');
  await page.waitForTimeout(200);
  check((await visibleCount(page.getByText('Stop everything that is running and close?'))) === 0, 'with text in New change and nothing running no close question is asked');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  check(await gone(dialog), 'New change closes on Cancel before the close demo');
  await go('/sdlc?demo=close');
  check(await appears(page.getByText('Stop everything that is running and close?')), '?demo=close asks the close question');
  await page.getByRole('button', { name: /New change/ }).dispatchEvent('click');
  await appears(idea);
  await idea.fill('flag suspicious prices');
  check((await visibleCount(page.getByText('Stop everything that is running and close?'))) === 1, 'New change with text adds no question to the close question');
  check((await visibleCount(page.getByText('A: building in kata'))) === 1 && (await visibleCount(page.getByText('B: writing its spec'))) === 1, 'the close question names the running changes');
  await page.getByRole('button', { name: 'Keep working' }).dispatchEvent('click');
  await page.waitForTimeout(300);
  check((await visibleCount(idea)) === 1, 'Keep working leaves New change open with its text');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await go('/sdlc');
  await page.getByRole('button', { name: /New change/ }).click();
  await appears(idea);

  // Start starts the change from the dialog (R14.2): New change closes and the triage preview of the started change opens.
  await idea.fill('flag suspicious prices');
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  check(await appears(dialog.getByRole('button', { name: 'Start run' })), 'Start closes New change and opens the start preview');
  check((await visibleCount(idea)) === 0, 'New change is gone after Start');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await gone(dialog);
  await go('/sdlc');

  const refresh = page.getByRole('button', { name: 'Refresh instructions' });
  check(await appears(refresh), 'the instructions row offers Refresh instructions');
  await refresh.click();
  check(await appears(dialog.getByRole('button', { name: 'Start run' })), 'Refresh instructions opens the run preview');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  check(await gone(dialog), 'the run preview cancels');

  // 3. The scripted triage
  await go('/sdlc?demo=start');
  const start = dialog.getByRole('button', { name: 'Start run' });
  check(await appears(start), '?demo=start opens the triage preview');
  await start.click();
  const light = page.getByText('Take the light track').first();
  check(await appears(light), 'the triage asks with Take the light track');
  check((await visibleCount(page.getByText('Take the full pipeline instead'))) > 0, 'the triage offers the full pipeline instead');
  check((await visibleCount(page.getByText('Stop here'))) > 0, 'the triage offers Stop here');
  check((await visibleCount(page.getByText(/light.track/i))) > 1, 'the triage printed a light-track verdict');
  await page.locator('input[type="radio"][value="Take the light track"]').click();
  await page.getByRole('button', { name: /Send answer/ }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  try {
    await page.waitForURL(`**${STARTED_FIX}`, { timeout: 15000 });
    check(true, 'taking the light track lands on the new fix');
  } catch {
    check(false, `taking the light track did not land on ${STARTED_FIX} (at ${new URL(page.url()).pathname})`);
  }
  check(errors.length === 0, `no runtime error was logged${errors.length ? `: ${errors[0]}` : ''}`);
} finally {
  await close();
}
done();
