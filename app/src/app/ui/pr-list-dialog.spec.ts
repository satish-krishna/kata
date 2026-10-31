import { TestBed } from '@angular/core/testing';
import type { PrEntry } from '@bindings/PrEntry';
import type { PrResult } from '@bindings/PrResult';
import { render } from '../../testing/render';
import { PrListDialog } from './pr-list-dialog';

const url = (repo: string) => `https://github.com/acme/${repo}/pull/7`;
const opened = (repo: string): PrResult => ({ repo, outcome: { kind: 'opened', url: url(repo) } });
const failed = (repo: string, error: string): PrResult => ({ repo, outcome: { kind: 'failed', error } });

const dialog = () => document.body.querySelector('[role="dialog"]')!;
const text = () => dialog().textContent!.replace(/\s+/g, ' ');
const button = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent!.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();
};
const open = async (results: PrResult[] | null) => {
  const out = await render(PrListDialog, { results });
  await settle();
  return out;
};

afterEach(() => TestBed.resetTestingModule());

describe('PrListDialog', () => {
  it('pull request list shows a link per repository (R13.1)', async () => {
    await open([opened('commerce-core'), opened('customer-portal'), opened('commerce-docs')]);
    const rows = Array.from(dialog().querySelectorAll('li'));
    expect(rows.map((r) => r.querySelector('.k-mono')!.textContent!.trim())).toEqual(['commerce-core', 'customer-portal', 'commerce-docs']);
    const links = Array.from(dialog().querySelectorAll<HTMLAnchorElement>('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([url('commerce-core'), url('customer-portal'), url('commerce-docs')]);
    expect(text()).toContain('opened');
    expect(dialog().querySelector('h2')!.textContent).toContain('Pull requests');
  });

  it('a reused pull request says it was already open', async () => {
    await open([{ repo: 'commerce-core', outcome: { kind: 'reused', url: url('commerce-core') } }]);
    expect(text()).toContain('already open, reused');
    expect(dialog().querySelector('a')!.getAttribute('href')).toBe(url('commerce-core'));
  });

  it('retry is offered when any pull request failed (R13.2)', async () => {
    const { fixture } = await open([opened('commerce-core'), failed('customer-portal', 'gh: HTTP 502 from api.github.com')]);
    expect(text()).toContain('failed');
    expect(text()).toContain('gh: HTTP 502 from api.github.com');
    const retry = vi.fn();
    fixture.componentInstance.retry.subscribe(retry);
    expect(button('Retry')).toBeDefined();
    button('Retry')!.click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(dialog().querySelectorAll('a').length).toBe(1);
  });

  it('offers Close, not Retry, when every pull request is open', async () => {
    const { fixture } = await open([opened('commerce-core')]);
    const close = vi.fn();
    fixture.componentInstance.close.subscribe(close);
    expect(button('Retry')).toBeUndefined();
    button('Close')!.click();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is closed while there are no results', async () => {
    await open(null);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('PrListDialog, a branch name clash and what was left behind', () => {
  const entry = (repo: string, branch: string): PrEntry => ({ repo, url: url(repo), number: 7, branch, pushedHead: 'abc', state: 'open', seenAt: 1 });

  it('a clash lists what was pushed with its links, the clashing repository and branch, and offers a new name (R10.2)', async () => {
    const { fixture } = await render(PrListDialog, {
      results: [opened('api'), { repo: 'kata', outcome: { kind: 'clash', branch: 'feat/PROJ-123-reset' } }] satisfies PrResult[],
    });
    await settle();
    expect(dialog().querySelector<HTMLAnchorElement>('a')!.getAttribute('href')).toBe(url('api'));
    expect(text()).toContain('feat/PROJ-123-reset');
    expect(text()).toContain('kata');
    expect(button('Retry')).toBeUndefined();
    let branch: string | null = null;
    fixture.componentInstance.renameBranch.subscribe((b: string) => (branch = b));
    button('Pick a new branch name')!.click();
    expect(branch).toBe('feat/PROJ-123-reset');
  });

  it('shows what an earlier branch name still holds on GitHub, with its link (R10.4)', async () => {
    await render(PrListDialog, { results: [opened('api')], leftBehind: [entry('api', 'feat/PROJ-123-reset')] });
    await settle();
    expect(text()).toContain('api is still on GitHub under feat/PROJ-123-reset, close by hand');
    const hrefs = Array.from(dialog().querySelectorAll<HTMLAnchorElement>('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([url('api'), url('api')]);
  });
});
