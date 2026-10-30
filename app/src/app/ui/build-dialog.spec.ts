import { Injector } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { BuildDialog, buildRequest, createBuildForm, type BuildDialogMode, type BuildFormState } from './build-dialog';

let host: HTMLElement;
const root = () => host;
const text = (e: Element) => e.textContent!.replace(/\s+/g, ' ').trim();
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
const hours = () => root().querySelector<HTMLInputElement>('input[aria-label="Hours"]')!;
const minutes = () => root().querySelector<HTMLInputElement>('input[aria-label="Minutes"]')!;
const instructions = () => root().querySelector<HTMLTextAreaElement>('textarea')!;

/** jsdom cannot drive a CDK overlay, so the pick goes through the select's own valueChange output, which is what a click on an item raises. */
const pickRepo = async (fixture: ComponentFixture<BuildDialog>, repo: string) => {
  fixture.debugElement.query(By.css('hlm-select')).triggerEventHandler('valueChange', repo);
  await settle();
};

/** The form is made by whoever owns the preview; the component only draws it. */
async function open(mode: BuildDialogMode, repos = ['commerce-docs', 'commerce-core', 'customer-portal']) {
  TestBed.configureTestingModule({ imports: [BuildDialog] });
  const state: BuildFormState = createBuildForm(TestBed.inject(Injector), mode === 'round');
  const fixture = TestBed.createComponent(BuildDialog);
  host = fixture.nativeElement as HTMLElement;
  fixture.componentRef.setInput('mode', mode);
  fixture.componentRef.setInput('repos', repos);
  fixture.componentRef.setInput('state', state);
  await fixture.whenStable();
  await settle();
  return { fixture, state, request: () => buildRequest(state, mode === 'round'), valid: () => state.form().valid() };
}

describe('BuildDialog', () => {
  it('is the build\'s fields and nothing else: no dialog, no title, no buttons', async () => {
    await open('start');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(root().querySelector('button')).toBeNull();
    expect(root().querySelector('[hlmDialogTitle]')).toBeNull();
  });

  it('defaults to two hours, explains the limit, and asks for 7200 seconds', async () => {
    const { request } = await open('start');
    expect(hours().value).toBe('2');
    expect(minutes().value).toBe('0');
    expect(text(root())).toContain("Time limit for each repository's run. Time spent waiting for your answers does not count. There is no spending ceiling.");
    expect(root().querySelector('textarea')).toBeNull();
    expect(root().querySelector('hlm-select')).toBeNull();
    expect(request()).toEqual({ timeoutSecs: 7200, instructions: null, repo: null });
  });

  it('zero time limit is invalid', async () => {
    const { valid, request } = await open('start');
    await typeInto(hours(), '0');
    expect(valid()).toBe(false);
    await typeInto(minutes(), '15');
    expect(valid()).toBe(true);
    expect(request().timeoutSecs).toBe(900);
  });

  it('a blank or negative time field is invalid', async () => {
    const { valid } = await open('continue');
    await typeInto(hours(), '');
    expect(valid()).toBe(false);
    await typeInto(hours(), '1');
    await typeInto(minutes(), '-5');
    expect(valid()).toBe(false);
  });

  it('round mode shows the time limit and needs instructions and a repository (R8.1)', async () => {
    const { fixture, valid, request } = await open('round');
    expect(text(root())).toContain('The agent works on the instructions inside this repository, after any of its unfinished tasks.');
    expect(hours()).not.toBeNull();
    expect(valid()).toBe(false);
    await typeInto(instructions(), '  rename the status field to state  ');
    expect(valid()).toBe(false);
    await pickRepo(fixture, 'commerce-core');
    expect(valid()).toBe(true);
    await typeInto(hours(), '4');
    await typeInto(minutes(), '0');
    expect(request()).toEqual({ timeoutSecs: 14400, instructions: 'rename the status field to state', repo: 'commerce-core' });
  });

  it('round mode cannot start without a repository (R8.3)', async () => {
    const { valid } = await open('round');
    await typeInto(instructions(), 'rename the status field to state');
    expect(valid()).toBe(false);
  });

  it('round mode cannot start on blank instructions', async () => {
    const { fixture, valid } = await open('round');
    await pickRepo(fixture, 'commerce-core');
    await typeInto(instructions(), '   ');
    expect(valid()).toBe(false);
  });

  it('a fresh form starts empty: nothing from an earlier open is shown', async () => {
    const first = await open('round');
    await typeInto(instructions(), 'something');
    await typeInto(hours(), '5');
    first.fixture.destroy();
    TestBed.resetTestingModule();
    const second = await open('round');
    expect(instructions().value).toBe('');
    expect(hours().value).toBe('2');
    expect(second.valid()).toBe(false);
  });
});
