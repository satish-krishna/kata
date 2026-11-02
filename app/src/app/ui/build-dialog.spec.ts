import { Injector } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import type { RoundGroup } from '@bindings/RoundGroup';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import { BuildDialog, buildRequest, createBuildForm, picksOf, type BuildDialogMode, type BuildFormState } from './build-dialog';

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
const finding = (id: string, severity: 'high' | 'medium' | 'low', repo?: string): RoundOffer['findings'][number] => ({
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

/** The picks the backend starts the dialog with: every finding but the low ones. */
const picksFor = (offer: RoundOffer): RoundPicks => ({ picked: offer.findings.filter((f) => f.finding.severity !== 'low').map((f) => f.key), assigned: {}, notes: {} });

/** The groups the backend hands the dialog: one per repository the findings name, then those naming none. */
const groupsOf = (offer: RoundOffer): RoundGroup[] => {
  const named = [...new Set(offer.findings.flatMap((f) => (f.finding.repo === undefined ? [] : [f.finding.repo])))];
  const none = offer.findings.filter((f) => f.finding.repo === undefined);
  return [...named.map((repo) => ({ repo, findings: offer.findings.filter((f) => f.finding.repo === repo) })), ...(none.length === 0 ? [] : [{ repo: null, findings: none }])];
};

/** The form is made by whoever owns the preview; the component only draws it. */
async function open(mode: BuildDialogMode, offer: RoundOffer | null = null, plan: RoundPlan | null = null, groups: RoundGroup[] | null = null) {
  TestBed.configureTestingModule({ imports: [BuildDialog] });
  const state: BuildFormState = createBuildForm(TestBed.inject(Injector), offer ?? undefined, offer === null ? undefined : picksFor(offer));
  const fixture = TestBed.createComponent(BuildDialog);
  host = fixture.nativeElement as HTMLElement;
  fixture.componentRef.setInput('mode', mode);
  fixture.componentRef.setInput('offer', offer);
  fixture.componentRef.setInput('groups', groups ?? (offer === null ? [] : groupsOf(offer)));
  fixture.componentRef.setInput('plan', plan);
  fixture.componentRef.setInput('state', state);
  await fixture.whenStable();
  await settle();
  return { fixture, state, request: () => buildRequest(state), picks: () => picksOf(state.model()), valid: () => state.form().valid() };
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
    expect(request()).toEqual({ timeoutSecs: 7200 });
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

  it('a note in one repository goes into the picks the backend is asked about (R6.1)', async () => {
    const { picks } = await open('round', NO_REVIEW);
    await typeInto(notes()[2], '  Rename the upload button to Add photos  ');
    expect(picks().notes['storefront-web']).toBe('  Rename the upload button to Add photos  ');
    expect(picks().picked).toEqual([]);
  });

  it('lists each finding under its repository, the backend\'s picks ticked, and F8 with no repository beside a Fixed in select (R5.1)', async () => {
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

  it('puts each finding\'s checkbox in a field, named by a label that holds the finding\'s key (house style: a control belongs in a field)', async () => {
    await open('round', OFFER);
    for (const f of OFFER.findings) {
      const row = root().querySelector(`[data-finding="${f.key}"]`)!;
      const checkbox = row.querySelector<HTMLElement>('[role="checkbox"]')!;
      expect(checkbox.closest('[data-slot="field"]'), f.key).not.toBeNull();
      expect(checkbox.hasAttribute('aria-label'), f.key).toBe(false);
      expect(checkbox.id, f.key).not.toBe('');
      const label = row.querySelector<HTMLLabelElement>(`label[for="${checkbox.id}"]`);
      expect(label, f.key).not.toBeNull();
      expect(text(label!), f.key).toContain(f.key);
      expect(text(label!), f.key).toContain(`${f.key} is wrong.`);
    }
    const ids = Array.from(root().querySelectorAll('[data-finding] [role="checkbox"]')).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('picking and unpicking changes the picks the backend is asked about (R5.2)', async () => {
    const { picks } = await open('round', OFFER);
    box('F2').click();
    box('F4').click();
    await settle();
    expect(checked('F2')).toBe(false);
    expect(checked('F4')).toBe(true);
    expect(picks().picked).toContain('F4');
    expect(picks().picked).not.toContain('F2');
  });

  it('the repository chosen for a finding that names none goes into the picks (R5.3)', async () => {
    const { fixture, picks } = await open('round', OFFER);
    await pickRepo(fixture, 'storefront-web');
    expect(picks().assigned).toEqual({ F8: 'storefront-web' });
  });

  it('pairs the blocked reason the backend gives with a status dot, so the warning is not colour alone', async () => {
    await open('round', OFFER, { blocked: 'Choose a repository for F8.', requests: [] });
    expect(summary()).toContain('Choose a repository for F8.');
    expect(root().querySelector('.k-round__blocked')!.querySelector('.k-status__dot')).not.toBeNull();
  });

  it('says exactly which agents will start and what each will fix, as the backend\'s plan has it (R5.4)', async () => {
    await open('round', OFFER, {
      blocked: null,
      requests: [
        { repo: 'catalog-api', instructions: 'x', summary: 'catalog-api · F1, F2, F3' },
        { repo: 'storefront-web', instructions: 'y', summary: 'storefront-web · F5, F6, F8' },
      ],
    });
    expect(summary()).toContain('Starts 2 agents');
    expect(summary()).toContain('catalog-api · F1, F2, F3');
    expect(summary()).toContain('storefront-web · F5, F6, F8');
  });

  it('a note is kept for its repository in the picks (R6.2)', async () => {
    const { picks } = await open('round', OFFER);
    await typeInto(notes()[1], 'Keep the 8 MB limit');
    expect(picks().notes['catalog-api']).toBe('Keep the 8 MB limit');
  });

  it('a fresh form starts with the picks it is given: nothing from an earlier open is shown', async () => {
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

  it('lists a finding of a repository outside the build under that repository, with a Fixed in select (F9)', async () => {
    const outside: RoundOffer = { review: 1, repos: REPOS, findings: [{ key: 'F9', repo: null, finding: { id: 'F9', severity: 'high', text: 'F9 is wrong. It needs a fix.', repo: 'legacy-api' } }] };
    await open('round', outside);
    const row = root().querySelector('[data-finding="F9"]')!;
    expect(row).not.toBeNull();
    expect(checked('F9')).toBe(true);
    expect(row.closest('section')!.querySelector('h3')!.textContent!.trim()).toBe('legacy-api');
    expect(row.querySelector('hlm-select')).not.toBeNull();
    expect(text(row)).toContain('Fixed in');
    expect(notes()).toHaveLength(3);
  });

  it('lists the findings of a repository in the order of the groups it is given, the way the Review group does', async () => {
    const mk = (key: string) => finding(key, 'medium', 'catalog-api');
    const offer: RoundOffer = { review: 1, repos: REPOS, findings: [mk('F1'), mk('F2'), mk('F3')] };
    await open('round', offer, null, [{ repo: 'catalog-api', findings: [offer.findings[2], offer.findings[0], offer.findings[1]] }]);
    const keys = Array.from(root().querySelectorAll('[data-finding]')).map((e) => e.getAttribute('data-finding'));
    expect(keys).toEqual(['F3', 'F1', 'F2']);
  });
});

describe('BuildDialog shows the backend\'s plan', () => {
  it('draws the plan it is given instead of making one', async () => {
    const offer: RoundOffer = { review: 1, repos: ['api'], findings: [] };
    const plan: RoundPlan = { blocked: null, requests: [{ repo: 'api', instructions: 'Fix F1.', summary: 'api · F1' }] };
    TestBed.configureTestingModule({ imports: [BuildDialog] });
    const fixture = TestBed.createComponent(BuildDialog);
    fixture.componentRef.setInput('mode', 'round');
    fixture.componentRef.setInput('offer', offer);
    fixture.componentRef.setInput('state', createBuildForm(TestBed.inject(Injector), offer));
    fixture.componentRef.setInput('plan', plan);
    await fixture.whenStable();
    const summary = fixture.nativeElement.querySelector('[data-round-summary]') as HTMLElement;
    expect(summary.textContent).toContain('Starts 1 agent');
    expect(summary.textContent).toContain('api · F1');
    fixture.componentRef.setInput('plan', { blocked: 'Pick a finding or write a note.', requests: [] });
    await fixture.whenStable();
    expect(summary.textContent).toContain('Pick a finding or write a note.');
  });
});
