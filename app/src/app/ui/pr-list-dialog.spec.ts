import { TestBed } from '@angular/core/testing';
import type { PrEntry } from '@bindings/PrEntry';
import type { DeclareView } from '@bindings/DeclareView';
import { render } from '../../testing/render';
import { PrListDialog } from './pr-list-dialog';

const url = (repo: string) => `https://github.com/acme/${repo}/pull/7`;

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = () => dialog().textContent!.replace(/\s+/g, ' ');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
afterEach(() => TestBed.resetTestingModule());

describe("PrListDialog, the plugin's answer to declaring done", () => {
  const recorded = (repo: string, number: number) => ({ repo, url: url(repo), number, source: 'plugin' as const });
  const show = async (view: DeclareView | null) => {
    const out = await render(PrListDialog, { view });
    await settle();
    return out;
  };

  it('done lists every pull request with its link, the master last (R7.1 passes)', async () => {
    await show({ kind: 'done', pullRequests: [recorded('commerce-core', 1), recorded('customer-portal', 2), recorded('commerce-docs', 3)], warnings: [] });
    const rows = Array.from(dialog().querySelectorAll('li'));
    expect(rows.map((r) => r.querySelector('.k-mono')!.textContent!.trim())).toEqual(['commerce-core', 'customer-portal', 'commerce-docs']);
    expect(Array.from(dialog().querySelectorAll<HTMLAnchorElement>('a')).map((a) => a.getAttribute('href'))).toEqual([url('commerce-core'), url('customer-portal'), url('commerce-docs')]);
    expect(button('Close')).toBeDefined();
    expect(button('Declare done again')).toBeUndefined();
  });

  it("done shows the plugin's warnings, such as an after hook that failed, with the pull requests (F22)", async () => {
    const warning = 'after hook announce failed with exit code 1; nothing was undone';
    await show({ kind: 'done', pullRequests: [recorded('commerce-core', 1)], warnings: [warning] });
    const warned = dialog().querySelector('.k-status--warning');
    expect(warned).not.toBeNull();
    expect(warned!.textContent!.trim()).toBe(warning);
    expect(warned!.querySelector('.k-status__dot')).not.toBeNull();
    expect(dialog().querySelector('a')!.getAttribute('href')).toBe(url('commerce-core'));
  });

  it('a refusal shows every problem as the plugin wrote it and says nothing was pushed (R7.1 refuses, R7.5)', async () => {
    const problems = [
      'the latest review (review 1) has unresolved high findings: F1 (commerce-core, src/upload.ts:10): The limit is not enforced.',
      'customer-portal has uncommitted files: a.rs',
    ];
    const { fixture } = await show({ kind: 'notReady', problems });
    for (const p of problems) expect(text()).toContain(p);
    expect(text()).toContain('Nothing was pushed.');
    expect(button('Declare done again')).toBeUndefined();
    const run = vi.fn();
    const round = vi.fn();
    fixture.componentInstance.runReview.subscribe(run);
    fixture.componentInstance.anotherRound.subscribe(round);
    button('Run review')!.click();
    button('Another round')!.click();
    expect([run, round].map((f) => f.mock.calls.length)).toEqual([1, 1]);
  });

  it('a part-way failure shows what was pushed, which pull requests opened, and offers to declare done again (R7.1 fails)', async () => {
    const { fixture } = await show({
      kind: 'partial',
      pushed: ['commerce-core', 'customer-portal'],
      opened: [recorded('commerce-core', 1)],
      failed: ['opening the pull request in customer-portal failed: GraphQL: something went wrong', 'pushed so far: commerce-core, customer-portal; running done again carries on from there'],
    });
    expect(text()).toContain('Pushed: commerce-core, customer-portal');
    expect(dialog().querySelector<HTMLAnchorElement>('a')!.getAttribute('href')).toBe(url('commerce-core'));
    expect(text()).toContain('opening the pull request in customer-portal failed: GraphQL: something went wrong');
    const again = vi.fn();
    fixture.componentInstance.retry.subscribe(again);
    button('Declare done again')!.click();
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('a machine that could not run the step says so and claims nothing as pushed (R7.1 cannot run)', async () => {
    await show({ kind: 'couldNotRun', message: 'ai-sdlc needs Node.js 22.18 or later' });
    expect(text()).toContain('ai-sdlc needs Node.js 22.18 or later');
    expect(text()).toContain('Nothing is claimed as pushed.');
    expect(button('Declare done again')).toBeUndefined();
  });
});

describe('PrListDialog, what an earlier branch name left behind', () => {
  const entry = (repo: string, branch: string): PrEntry => ({ repo, url: url(repo), number: 7, branch, pushedHead: 'abc', state: 'open', seenAt: 1 });

  it('is closed with no answer and nothing left behind', async () => {
    await render(PrListDialog, { view: null });
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows what an earlier branch name still holds on GitHub, with its link, even with no answer (R10.4)', async () => {
    await render(PrListDialog, { view: null, leftBehind: [entry('api', 'feat/PROJ-123-reset')] });
    await settle();
    expect(text()).toContain('api is still on GitHub under feat/PROJ-123-reset, close by hand');
    expect(Array.from(dialog().querySelectorAll<HTMLAnchorElement>('a')).map((a) => a.getAttribute('href'))).toEqual([url('api')]);
  });

  it('lists it after the pull requests of the answer', async () => {
    await render(PrListDialog, { view: { kind: 'done', pullRequests: [{ repo: 'api', url: url('api'), number: 7, source: 'plugin' }], warnings: [] }, leftBehind: [entry('api', 'feat/PROJ-123-reset')] });
    await settle();
    expect(Array.from(dialog().querySelectorAll<HTMLAnchorElement>('a')).map((a) => a.getAttribute('href'))).toEqual([url('api'), url('api')]);
  });
});
