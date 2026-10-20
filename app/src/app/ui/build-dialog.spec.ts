import { TestBed } from '@angular/core/testing';
import { render } from '../../testing/render';
import { BuildDialog, type BuildStartRequest } from './build-dialog';

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label) as HTMLButtonElement;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
const typeInto = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input'));
  await settle();
};
const hours = () => dialog().querySelector<HTMLInputElement>('input[aria-label="Hours"]')!;
const minutes = () => dialog().querySelector<HTMLInputElement>('input[aria-label="Minutes"]')!;
const instructions = () => dialog().querySelector<HTMLTextAreaElement>('textarea')!;

/** jsdom cannot drive a CDK overlay, so a repository is picked through the select's own event. */
const pickRepo = async (repo: string) => {
  const select = dialog().querySelector('hlm-select')!;
  select.dispatchEvent(new CustomEvent('valueChange', { detail: repo }));
  await settle();
};

async function open(mode: 'start' | 'continue' | 'round', repos = ['claims-intent', 'claims-core', 'customer-portal']) {
  const out = await render(BuildDialog, { open: true, mode, repos });
  await settle();
  const got: BuildStartRequest[] = [];
  out.fixture.componentInstance.start.subscribe((v) => got.push(v));
  return { ...out, got };
}

describe('BuildDialog', () => {
  it('renders nothing while closed', async () => {
    await render(BuildDialog, { open: false, mode: 'start', repos: ['m'] });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    ['start', 'Start build'],
    ['continue', 'Continue build'],
    ['round', 'Start round'],
  ] as const)('titles %s mode and names its primary button', async (mode, label) => {
    await open(mode);
    expect(text(dialog().querySelector('[hlmDialogTitle]')!)).toBe(label);
    expect(button(label)).toBeDefined();
  });

  it('defaults to two hours, explains the limit, and starts a build with 7200 seconds', async () => {
    const { got } = await open('start');
    expect(hours().value).toBe('2');
    expect(minutes().value).toBe('0');
    expect(text(dialog())).toContain("Time limit for each repository's run. Time spent waiting for your answers does not count. There is no spending ceiling.");
    expect(dialog().querySelector('textarea')).toBeNull();
    expect(dialog().querySelector('hlm-select')).toBeNull();
    button('Start build').click();
    await settle();
    expect(got).toEqual([{ timeoutSecs: 7200, instructions: null, repo: null }]);
  });

  it('zero time limit disables the primary button', async () => {
    const { got } = await open('start');
    await typeInto(hours(), '0');
    expect(button('Start build').disabled).toBe(true);
    button('Start build').click();
    await settle();
    expect(got).toEqual([]);
    await typeInto(minutes(), '15');
    expect(button('Start build').disabled).toBe(false);
  });

  it('a blank or negative time field disables the primary button', async () => {
    await open('continue');
    await typeInto(hours(), '');
    expect(button('Continue build').disabled).toBe(true);
    await typeInto(hours(), '1');
    await typeInto(minutes(), '-5');
    expect(button('Continue build').disabled).toBe(true);
  });

  it('round mode shows the time limit and needs instructions and a repository (R8.1)', async () => {
    const { got } = await open('round');
    expect(text(dialog())).toContain('The agent works on the instructions inside this repository, after any of its unfinished tasks.');
    expect(hours()).not.toBeNull();
    expect(button('Start round').disabled).toBe(true);
    await typeInto(instructions(), '  rename the status field to state  ');
    expect(button('Start round').disabled).toBe(true);
    await pickRepo('claims-core');
    expect(button('Start round').disabled).toBe(false);
    await typeInto(hours(), '4');
    await typeInto(minutes(), '0');
    button('Start round').click();
    await settle();
    expect(got).toEqual([{ timeoutSecs: 14400, instructions: 'rename the status field to state', repo: 'claims-core' }]);
  });

  it('round mode cannot start without a repository (R8.3)', async () => {
    const { got } = await open('round');
    await typeInto(instructions(), 'rename the status field to state');
    expect(button('Start round').disabled).toBe(true);
    button('Start round').click();
    await settle();
    expect(got).toEqual([]);
  });

  it('round mode cannot start on blank instructions', async () => {
    await open('round');
    await pickRepo('claims-core');
    await typeInto(instructions(), '   ');
    expect(button('Start round').disabled).toBe(true);
  });

  it('starts empty again each time it opens', async () => {
    const { fixture } = await open('round');
    await typeInto(instructions(), 'something');
    await typeInto(hours(), '5');
    fixture.componentRef.setInput('open', false);
    await settle();
    fixture.componentRef.setInput('open', true);
    await settle();
    expect(instructions().value).toBe('');
    expect(hours().value).toBe('2');
  });

  it('emits cancel from Cancel', async () => {
    const { fixture } = await open('start');
    let n = 0;
    fixture.componentInstance.cancel.subscribe(() => n++);
    button('Cancel').click();
    expect(n).toBe(1);
  });
});
