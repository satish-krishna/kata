import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { render } from '../../../testing/render';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { ContextPage } from './context-page';

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};
const text = (c: HTMLElement) => c.textContent!.replace(/\s+/g, ' ');
const button = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.getAttribute('aria-label') ?? b.textContent!.trim()) === label);
const repoButtons = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLButtonElement>('nav[aria-label="Repositories"] button'));

async function mount(repo = 'commerce-core', transport = new MockTransport()) {
  const params = new BehaviorSubject(convertToParamMap({ system: 'commerce', repo }));
  const out = await render(ContextPage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: params.asObservable() } },
  ]);
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  await settle();
  out.fixture.detectChanges();
  return { ...out, params, navigate, transport };
}

afterEach(() => TestBed.resetTestingModule());

describe('ContextPage', () => {
  it('shows the context file as a full screen document: outline, markdown, and the front matter in the rail', async () => {
    const { container } = await mount();
    const doc = container.querySelector<HTMLElement>('[data-testid="context-doc"]')!;
    expect(text(doc)).toContain('intent/commerce/context/commerce-core.md');
    expect(container.querySelector('.k-crumbs__item')!.textContent).toBe('commerce-core · context');
    expect(doc.querySelector('.k-md h1')!.textContent).toBe('commerce-core');
    expect(doc.querySelector('.k-md table')).not.toBeNull();
    expect(Array.from(doc.querySelectorAll('.k-docview__toclink')).map((b) => b.textContent!.trim())).toEqual([
      'Stack',
      'Modules',
      'Import',
      'Lifecycle',
      'Conventions',
    ]);
    expect(Array.from(doc.querySelectorAll('.k-docview__fields dt')).map((d) => d.textContent)).toEqual(['repo', 'system', 'source_commit', 'updated']);
    expect(text(doc)).not.toContain('source_commit: 4f1c');
    expect(doc.querySelector('[data-testid="recent-runs"]')).toBeNull();
  });

  it('reads the file from the master of the open workspace', async () => {
    const transport = new MockTransport();
    const read = vi.spyOn(transport, 'sdlcReadContext');
    await mount('customer-portal', transport);
    expect(read).toHaveBeenCalledWith(`${MOCK_WORKSPACE_FOLDER}/${MOCK_MASTER}`, 'commerce', 'customer-portal');
  });

  it('lists every product repo with its context state, marks the one shown, and opens another on click', async () => {
    const { container, navigate } = await mount('customer-portal');
    const rows = repoButtons(container);
    expect(rows.map((b) => b.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      'commerce-core fresh',
      'customer-portal stale · 14 commits',
      'billing-api not checked out',
    ]);
    expect(rows.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    rows[0].click();
    expect(navigate).toHaveBeenCalledWith(['/sdlc', 'commerce', 'context', 'commerce-core']);
  });

  it('follows the route to another repo without remounting', async () => {
    const { container, params, fixture } = await mount('commerce-core');
    params.next(convertToParamMap({ system: 'commerce', repo: 'customer-portal' }));
    await settle();
    fixture.detectChanges();
    expect(container.querySelector('.k-md h1')!.textContent).toBe('customer-portal');
  });

  it('hands Refresh context to the workspace home, which owns the run', async () => {
    const { container, navigate } = await mount('customer-portal');
    button(container, 'Refresh context for customer-portal')!.click();
    expect(navigate).toHaveBeenCalledWith(['/sdlc'], { queryParams: { context: 'customer-portal' } });
  });

  it('says so when a repo has no context file, and offers no run where none is possible', async () => {
    const { container } = await mount('billing-api');
    expect(text(container)).toContain('billing-api has no context file yet.');
    expect(text(container)).not.toContain('Run context');
    expect(button(container, 'Run context for billing-api')).toBeUndefined();
  });

  it('goes back to the workspace from the breadcrumb', async () => {
    const { container, navigate } = await mount();
    button(container, 'Back to the changes list')!.click();
    expect(navigate).toHaveBeenCalledWith(['/sdlc']);
  });
});
