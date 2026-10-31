import { Injector } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { Finding } from '../lib/sdlc';
import type { RoundOffer } from '../lib/build-round';
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
const notes = () => Array.from(root().querySelectorAll<HTMLTextAreaElement>('textarea'));
const box = (key: string) => root().querySelector<HTMLElement>(`[data-finding="${key}"] [role="checkbox"]`)!;
const checked = (key: string) => box(key).getAttribute('aria-checked') === 'true';
const summary = () => text(root().querySelector('[data-round-summary]')!);

/** jsdom cannot drive a CDK overlay, so the pick goes through the select's own valueChange output, which is what a click on an item raises. */
const pickRepo = async (fixture: ComponentFixture<BuildDialog>, repo: string) => {
  fixture.debugElement.query(By.css('hlm-select')).triggerEventHandler('valueChange', repo);
  await settle();
};

const REPOS = ['ai-sdlc', 'catalog-api', 'storefront-web'];
const finding = (id: string, severity: Finding['severity'], repo?: string): RoundOffer['findings'][number] => ({
  key: id,
  finding: { id, severity, text: `${id} is wrong. It needs a fix.`, file: `src/${id}.cs`, ...(repo === undefined ? {} : { repo }) },
  repo: repo ?? null,
});
/** F1 to F4 in catalog-api, F5 to F7 in storefront-web, F8 names no repository. */
const OFFER: RoundOffer = {
  review: 2,
  repos: REPOS,
  findings: [
    finding('F1', 'high', 'catalog-api'),
    finding('F2', 'medium', 'catalog-api'),
    finding('F3', 'medium', 'catalog-api'),
    finding('F4', 'low', 'catalog-api'),
    finding('F5', 'high', 'storefront-web'),
    finding('F6', 'medium', 'storefront-web'),
    finding('F7', 'low', 'storefront-web'),
    finding('F8', 'medium'),
  ],
};
const NO_REVIEW: RoundOffer = { review: null, repos: REPOS, findings: [] };

/** The form is made by whoever owns the preview; the component only draws it. */
async function open(mode: BuildDialogMode, offer: RoundOffer | null = null) {
  TestBed.configureTestingModule({ imports: [BuildDialog] });
  const state: BuildFormState = createBuildForm(TestBed.inject(Injector), mode === 'round', offer ?? undefined);
  const fixture = TestBed.createComponent(BuildDialog);
  host = fixture.nativeElement as HTMLElement;
  fixture.componentRef.setInput('mode', mode);
  fixture.componentRef.setInput('offer', offer);
  fixture.componentRef.setInput('state', state);
  await fixture.whenStable();
  await settle();
  return { fixture, state, request: () => buildRequest(state, mode === 'round', offer ?? undefined), valid: () => state.form().valid() };
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
    expect(request()).toEqual({ timeoutSecs: 7200, rounds: null });
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

  it('a round with no review lists no finding and offers a note for each repository (R5.6)', async () => {
    await open('round', NO_REVIEW);
    expect(root().querySelector('[role="checkbox"]')).toBeNull();
    expect(notes()).toHaveLength(3);
    expect(text(root())).toContain('Also tell the ai-sdlc agent (optional)');
    expect(text(root())).toContain('Also tell the storefront-web agent (optional)');
    expect(hours()).not.toBeNull();
  });

  it('a round cannot start on nothing: it says to pick a finding or write a note (R5.5)', async () => {
    const { valid } = await open('round', NO_REVIEW);
    expect(valid()).toBe(false);
    expect(summary()).toContain('Pick a finding or write a note.');
  });

  it('a note in one repository starts an agent there (R6.1)', async () => {
    const { valid, request } = await open('round', NO_REVIEW);
    await typeInto(notes()[2], '  Rename the upload button to Add photos  ');
    expect(valid()).toBe(true);
    expect(summary()).toContain('Starts 1 agent');
    expect(request().rounds!.map((r) => r.repo)).toEqual(['storefront-web']);
    expect(request().rounds![0].instructions).toContain('Rename the upload button to Add photos');
  });

  it('lists each finding under its repository, high and medium picked, low not, and F8 with no repository beside a Fixed in select (R5.1)', async () => {
    await open('round', OFFER);
    for (const key of ['F1', 'F2', 'F3', 'F5', 'F6', 'F8']) expect(checked(key), key).toBe(true);
    for (const key of ['F4', 'F7']) expect(checked(key), key).toBe(false);
    expect(notes()).toHaveLength(3);
    const f1 = text(root().querySelector('[data-finding="F1"]')!);
    expect(f1).toContain('F1');
    expect(f1).toContain('high');
    expect(f1).toContain('F1 is wrong.');
    expect(f1).toContain('src/F1.cs');
    expect(text(root())).toContain('No repository named');
    expect(root().querySelectorAll('hlm-select')).toHaveLength(1);
    expect(root().querySelector('[data-finding="F8"] hlm-select')).not.toBeNull();
    expect(text(root().querySelector('[data-finding="F8"]')!)).toContain('Fixed in');
  });

  it('picking and unpicking changes what the round fixes (R5.2)', async () => {
    const { fixture, request } = await open('round', OFFER);
    await pickRepo(fixture, 'catalog-api');
    box('F2').click();
    box('F4').click();
    await settle();
    expect(checked('F2')).toBe(false);
    expect(checked('F4')).toBe(true);
    const catalog = request().rounds!.find((r) => r.repo === 'catalog-api')!;
    expect(catalog.summary).toContain('F1, F3, F4');
  });

  it('a picked finding with no repository blocks the round until one is chosen (R5.3)', async () => {
    const { fixture, valid, request } = await open('round', OFFER);
    expect(valid()).toBe(false);
    expect(summary()).toContain('Choose a repository for F8.');
    await pickRepo(fixture, 'storefront-web');
    expect(valid()).toBe(true);
    expect(request().rounds!.find((r) => r.repo === 'storefront-web')!.summary).toContain('F5, F6, F8');
  });

  it('says exactly which agents will start and what each will fix (R5.4)', async () => {
    const { fixture } = await open('round', OFFER);
    await pickRepo(fixture, 'storefront-web');
    expect(summary()).toContain('Starts 2 agents');
    expect(summary()).toContain('catalog-api · F1, F2, F3');
    expect(summary()).toContain('storefront-web · F5, F6, F8');
  });

  it('a note goes with the picked findings of its repository (R6.2)', async () => {
    const { fixture, request } = await open('round', OFFER);
    await pickRepo(fixture, 'storefront-web');
    await typeInto(notes()[1], 'Keep the 8 MB limit');
    const catalog = request().rounds!.find((r) => r.repo === 'catalog-api')!;
    expect(catalog.instructions).toContain('F1');
    expect(catalog.instructions).toContain('Keep the 8 MB limit');
  });

  it('a fresh form starts with the defaults: nothing from an earlier open is shown', async () => {
    const first = await open('round', OFFER);
    box('F1').click();
    await typeInto(notes()[0], 'something');
    await typeInto(hours(), '5');
    first.fixture.destroy();
    TestBed.resetTestingModule();
    await open('round', OFFER);
    expect(checked('F1')).toBe(true);
    expect(notes()[0].value).toBe('');
    expect(hours().value).toBe('2');
  });
});
