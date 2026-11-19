import type { BaseCheck } from '@bindings/BaseCheck';
import type { StartChecks } from '@bindings/StartChecks';
import { render } from '../../testing/render';
import { AcceptCheckDialog } from './accept-check-dialog';
import { BuildFailurePanel } from './build-failure-panel';

const text = (c: Element) => c.textContent!.replace(/\s+/g, ' ').trim();
const BASE = '3c504eb';

const check = (name: string, over: Partial<BaseCheck> = {}): BaseCheck => ({
  check: name,
  state: 'passed',
  exitCode: 0,
  output: '',
  lineCount: 0,
  canAccept: false,
  accepted: false,
  startedAt: null,
  endedAt: null,
  ...over,
});
const failing = (name: string, over: Partial<BaseCheck> = {}): BaseCheck =>
  check(name, { state: 'failed', exitCode: 101, output: `error in ${name}\nline two`, lineCount: 2, canAccept: true, ...over });

/** `failed` checks that do not say what failed, then `passed` others, as the backend answers a start that stopped on the base. */
function start(failedNames: string[], passed: number, over: Partial<StartChecks> = {}): StartChecks {
  const checks = [...failedNames.map((n) => failing(n)), ...Array.from({ length: passed }, (_, i) => check(`ok-${i}`))];
  return { repo: 'kata', shown: { kind: 'baseFailure' }, base: BASE, checks, passed, setupHint: failedNames.length >= 3, startHeld: 'Accept or fix the failing checks first', finish: null, ...over };
}

const dialogOpen = () => document.body.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
const rows = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-failure-row]'));
const button = (root: ParentNode, label: string) => Array.from(root.querySelectorAll('button')).find((b) => text(b).startsWith(label))!;

describe('BuildFailurePanel shows why the build did not start, once, on the page', () => {
  it('shows one base failure once on the page r4.1', async () => {
    const { container } = await render(BuildFailurePanel, { start: start(['app-speed'], 11) });
    expect(text(container)).toContain('The build did not start');
    expect(text(container.querySelector('[data-failure-title]')!)).toBe('1 check fails on the base and does not say what failed');
    expect(text(container.querySelector('[data-failure-reason]')!)).toContain('cannot be told apart from a new one');
    const [row] = rows(container);
    expect(rows(container).length).toBe(1);
    expect(text(row)).toContain('app-speed');
    expect(text(row)).toContain('failed on the base');
    expect(text(row)).toContain(`exit 101 · ${BASE}`);
    expect(text(row)).toContain('Show output');
    expect(text(row)).toContain('Accept for this build…');
    expect(text(container.querySelector('[data-passed-fold]')!)).toContain('11 other checks passed on the base');
    expect(container.querySelector('[data-setup-hint]')).toBeNull();
    expect(dialogOpen()).toBe(false);
  });

  it('shows the output in a scrolling fixed-width block with its line count and a copy action r4.2', async () => {
    const { fixture, container } = await render(BuildFailurePanel, { start: start(['app-speed'], 1) });
    expect(container.querySelector('[data-output]')).toBeNull();
    button(container, 'Show output').click();
    await fixture.whenStable();
    const out = container.querySelector('[data-output]')!;
    expect(out.tagName).toBe('PRE');
    expect(out.textContent).toBe('error in app-speed\nline two');
    expect(text(container.querySelector('[data-output-foot]')!)).toContain('2 lines');
    expect(text(container.querySelector('[data-output-foot]')!)).toContain('the last 200 are kept');
    const copied: string[] = [];
    fixture.componentInstance.copy.subscribe((t) => copied.push(t));
    button(container, 'Copy output').click();
    expect(copied).toEqual(['error in app-speed\nline two']);
  });

  it('never reads the output as HTML r4.2', async () => {
    const hostile = failing('app-speed', { output: '<img src=x onerror="window.__hit=1"><b>bold</b>' });
    const { fixture, container } = await render(BuildFailurePanel, { start: start([], 0, { checks: [hostile] }) });
    button(container, 'Show output').click();
    await fixture.whenStable();
    expect(container.querySelector('[data-output] img, [data-output] b')).toBeNull();
    expect(container.querySelector('[data-output]')!.textContent).toContain('<img src=x');
  });

  const examples: [number, boolean, string | null][] = [
    [1, false, null],
    [2, false, null],
    [3, true, 'Three failed at once'],
    [9, true, 'Nine failed at once'],
  ];
  for (const [count, hint, words] of examples) {
    it(`lists ${count} failed check(s) each with its own accept and ${hint ? 'the setup hint' : 'no hint'} r4.3`, async () => {
      const names = Array.from({ length: count }, (_, i) => `check-${i}`);
      const { container } = await render(BuildFailurePanel, { start: start(names, 3) });
      expect(rows(container).map((r) => r.getAttribute('data-failure-row'))).toEqual(names);
      expect(container.querySelectorAll('[data-accept]').length).toBe(count);
      const hintEl = container.querySelector('[data-setup-hint]');
      if (!hint) expect(hintEl).toBeNull();
      else {
        expect(text(hintEl!)).toContain(words!);
        expect(text(hintEl!)).toContain('the setup is broken rather than the code');
        expect(text(hintEl!)).toContain('Read one output first');
      }
    });
  }

  it("shows another reason with the step it names, its output on request and no accept r4.5", async () => {
    const other = start([], 0, { checks: [], shown: { kind: 'otherReason', reason: 'The team step app-deps failed', step: 'app-deps', output: 'npm ERR! missing' }, startHeld: null });
    const { fixture, container } = await render(BuildFailurePanel, { start: other });
    expect(text(container)).toContain('The build did not start');
    expect(text(container.querySelector('[data-failure-title]')!)).toBe('The team step app-deps failed');
    expect(text(container.querySelector('[data-failure-row]')!)).toContain('app-deps');
    expect(container.querySelector('[data-accept]')).toBeNull();
    button(container, 'Show output').click();
    await fixture.whenStable();
    expect(container.querySelector('[data-output]')!.textContent).toBe('npm ERR! missing');
  });

  it('asks to accept exactly the check whose action was pressed, one at a time r5.4', async () => {
    const { fixture, container } = await render(BuildFailurePanel, { start: start(['a', 'b'], 0) });
    const asked: string[] = [];
    fixture.componentInstance.accept.subscribe((c) => asked.push(c));
    const accepts = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-accept]'));
    expect(accepts.map((b) => text(b))).toEqual(['Accept for this build… a', 'Accept for this build… b']);
    accepts[1].click();
    expect(asked).toEqual(['b']);
    expect(Array.from(container.querySelectorAll('button')).some((b) => /accept all/i.test(text(b)))).toBe(false);
  });

  it('offers no accept for a check that names its failures r5.5', async () => {
    const named = failing('named', { canAccept: false });
    const { container } = await render(BuildFailurePanel, { start: start(['unsaid'], 0, { checks: [failing('unsaid'), named] }) });
    expect(container.querySelector('[data-failure-row="named"] [data-accept]')).toBeNull();
    expect(container.querySelector('[data-failure-row="unsaid"] [data-accept]')).not.toBeNull();
  });

  it('marks an accepted check and says nothing is left to settle when all are accepted r5.2', async () => {
    const accepted = failing('app-speed', { canAccept: false, accepted: true });
    const { container } = await render(BuildFailurePanel, { start: start([], 2, { shown: { kind: 'allAccepted' }, checks: [accepted, check('ok')], startHeld: null }) });
    const row = container.querySelector('[data-failure-row="app-speed"]')!;
    expect(text(row)).toContain('accepted for this build');
    expect(row.querySelector('[data-accept]')).toBeNull();
    expect(text(container)).toContain('Nothing left to settle');
    expect(text(container)).toContain('reuses the base results');
  });

  it("shows the workflow's refusal as it is under the check, and leaves it unmarked r5.6", async () => {
    const { container } = await render(BuildFailurePanel, { start: start(['app-speed'], 0), refusal: { repo: 'kata', check: 'app-speed', problems: ['the base moved since the checks ran'] } });
    const alert = container.querySelector('[data-failure-row="app-speed"] [role="alert"]')!;
    expect(text(alert)).toContain('the base moved since the checks ran');
    expect(text(container.querySelector('[data-failure-row="app-speed"]')!)).not.toContain('accepted for this build');
  });

  it('names the check each action acts on to a screen reader r12.2', async () => {
    const { container } = await render(BuildFailurePanel, { start: start(['app-speed'], 0) });
    const row = container.querySelector('[data-failure-row="app-speed"]')!;
    const names = Array.from(row.querySelectorAll('button')).map((b) => text(b));
    expect(names).toContain('Show output of app-speed');
    expect(names).toContain('Accept for this build… app-speed');
    expect(Array.from(row.querySelectorAll('button')).every((b) => b.getAttribute('aria-label') === null)).toBe(true);
  });
});

describe('AcceptCheckDialog confirms one acceptance', () => {
  const request = { repo: 'kata', check: 'app-speed', base: BASE };

  it('opens only for a request and is a titled dialog naming the check and the base commit r5.1', async () => {
    await render(AcceptCheckDialog, { request: null });
    expect(dialogOpen()).toBe(false);
    await render(AcceptCheckDialog, { request });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(text(dialog.querySelector('[data-slot="dialog-title"]')!)).toBe('Accept app-speed for this build?');
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('[data-slot="dialog-title"]')!.id);
    const body = text(dialog);
    expect(body).toContain(BASE);
    expect(body).toContain('will not block this build at finish while the base stays at 3c504eb');
    expect(body).toContain('a new failure in it would go through unseen');
    expect(body).toContain('still runs');
    expect(body).toContain('its result is shown');
    expect(body).toContain('cannot be undone for this base commit');
  });

  it('confirms from Accept and cancels from Cancel and from Escape r5.3', async () => {
    const { fixture } = await render(AcceptCheckDialog, { request });
    const got: string[] = [];
    fixture.componentInstance.confirm.subscribe(() => got.push('confirm'));
    fixture.componentInstance.cancel.subscribe(() => got.push('cancel'));
    button(document.body.querySelector('[role="dialog"]')!, 'Accept app-speed').click();
    button(document.body.querySelector('[role="dialog"]')!, 'Cancel').click();
    expect(got).toEqual(['confirm', 'cancel']);
  });

  it('closes as a cancel on Escape r12.2', async () => {
    const { fixture } = await render(AcceptCheckDialog, { request });
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(n).toBe(1);
  });
});
