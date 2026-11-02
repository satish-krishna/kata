import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { render } from '../../testing/render';
import { KataTransport } from '../core/transport/kata-transport';
import { MockTransport } from '../core/transport/mock-transport';
import { SdlcToolbar } from './sdlc-toolbar';

const WS: WorkspaceEntry = { id: 'acme', name: 'acme-commerce', folder: '/a', last_opened: 1 };
const inputs = (over: Record<string, unknown> = {}) => ({
  workspaces: [WS], current: WS, missing: [], branch: 'main', ...over,
});
const byLabel = (c: HTMLElement, label: string) => c.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const switcher = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-label^="Switch workspace"]')!;

// The toolbar hosts the running-changes strip, which reads the running changes from the transport.
const provideTransport = () => TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useClass: MockTransport }] });
beforeEach(provideTransport);

describe('SdlcToolbar', () => {
  it('shows the ai-sdlc badge, the workspace, and the master branch in mono', async () => {
    const { container } = await render(SdlcToolbar, inputs());
    expect(byLabel(container, 'Switch mode (ai-sdlc)').textContent!.trim()).toBe('ai-sdlc');
    expect(container.textContent).toContain('acme-commerce');
    expect(container.querySelector('[data-testid="branch"]')!.textContent!.trim()).toBe('main');
  });

  it('hides the branch while the master repo has none to show', async () => {
    const { container } = await render(SdlcToolbar, inputs({ branch: null }));
    expect(container.querySelector('[data-testid="branch"]')).toBeNull();
  });

  it('names the branch chip for a reader who cannot see its text: title and accessible name say which branch is out of place', async () => {
    const { container } = await render(SdlcToolbar, inputs({ branch: 'main', crumbs: ['2026-10-16-price-flag'] }));
    const chip = container.querySelector('[data-testid="branch"]')!;
    const said = 'Master repository is on main, not change/2026-10-16-price-flag';
    expect(chip.getAttribute('title')).toBe(said);
    expect(chip.getAttribute('aria-label')).toBe(said);
    expect(chip.querySelector('ng-icon[name="lucideGitBranch"]')).not.toBeNull();
    expect(chip.textContent!.trim()).toBe('main');
  });

  it('names the recorded branch of the change as the one it should be on (R7.1)', async () => {
    const { container } = await render(SdlcToolbar, inputs({ branch: 'main', crumbs: ['2026-11-02-password-reset'], changeBranch: 'feat/PROJ-123-password-reset' }));
    const chip = container.querySelector('[data-testid="branch"]')!;
    const said = 'Master repository is on main, not feat/PROJ-123-password-reset';
    expect(chip.getAttribute('title')).toBe(said);
    expect(chip.getAttribute('aria-label')).toBe(said);
  });

  it('names the branch chip without a change when the toolbar has no change crumb', async () => {
    const { container } = await render(SdlcToolbar, inputs({ branch: 'main' }));
    const chip = container.querySelector('[data-testid="branch"]')!;
    expect(chip.getAttribute('title')).toBe('Master repository is on main');
    expect(chip.getAttribute('aria-label')).toBe('Master repository is on main');
  });

  it('shows the breadcrumb after the workspace', async () => {
    const { container } = await render(SdlcToolbar, inputs({ crumbs: ['commerce', '2026-10-12-photos'] }));
    expect(container.querySelector('nav')!.textContent).toContain('2026-10-12-photos');
  });

  it('emits switchMode and openSettings', async () => {
    const { fixture, container } = await render(SdlcToolbar, inputs());
    const got: string[] = [];
    fixture.componentInstance.switchMode.subscribe(() => got.push('mode'));
    fixture.componentInstance.openSettings.subscribe(() => got.push('settings'));
    byLabel(container, 'Switch mode (ai-sdlc)').click();
    byLabel(container, 'AI-SDLC settings').click();
    expect(got).toEqual(['mode', 'settings']);
  });

  it('the back link is shown, named and emits goBack', async () => {
    const back = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('button[aria-label="Back to the changes list"]');
    const none = await render(SdlcToolbar, inputs({ crumbs: ['c1'] }));
    expect(back(none.container)).toBeNull();
    TestBed.resetTestingModule();
    provideTransport();
    const { fixture, container } = await render(SdlcToolbar, inputs({ crumbs: ['c1'], back: 'Changes' }));
    const link = back(container)!;
    expect(link.textContent!.trim()).toBe('Changes');
    expect(link.disabled).toBe(false);
    expect(container.querySelector('nav')!.firstElementChild).toBe(link);
    let went = 0;
    fixture.componentInstance.goBack.subscribe(() => went++);
    link.click();
    expect(went).toBe(1);
  });

  it('withholds the workspace switcher and branch while blocked', async () => {
    const { container } = await render(SdlcToolbar, inputs({ blocked: true }));
    expect(switcher(container)).toBeNull();
    expect(container.querySelector('[data-testid="branch"]')).toBeNull();
    expect(byLabel(container, 'Switch mode (ai-sdlc)')).not.toBeNull();
  });

  it('projects the primary action', async () => {
    @Component({
      imports: [SdlcToolbar],
      template: `<app-sdlc-toolbar [workspaces]="[]" [current]="null" [missing]="[]" [branch]="null">
        <span id="primary">New change</span>
      </app-sdlc-toolbar>`,
    })
    class Host {}
    TestBed.configureTestingModule({ imports: [Host], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('#primary')).not.toBeNull();
  });

  it('projects the stage pills after the branch and the links before settings', async () => {
    @Component({
      imports: [SdlcToolbar],
      template: `<app-sdlc-toolbar [workspaces]="[]" [current]="null" [missing]="[]" branch="main" [crumbs]="['c1']">
        <span id="links" toolbarLinks>PRs</span>
        <span id="pills" toolbarStages>Pills</span>
        <span id="primary">New change</span>
      </app-sdlc-toolbar>`,
    })
    class Host {}
    TestBed.configureTestingModule({ imports: [Host], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const order = Array.from(root.querySelectorAll('[data-testid="branch"], #pills, #links, button[aria-label="AI-SDLC settings"], #primary'));
    expect(order.map((e) => e.id || e.getAttribute('data-testid') || e.getAttribute('aria-label'))).toEqual(['branch', 'pills', 'links', 'AI-SDLC settings', 'primary']);
  });
});

describe('SdlcToolbar without counts (R3.1)', () => {
  it('has no counts input, since the switcher shows names only', async () => {
    const { fixture } = await render(SdlcToolbar, { workspaces: [WS], current: WS, missing: [], branch: 'main' });
    expect('counts' in fixture.componentInstance).toBe(false);
  });
});

describe('SdlcToolbar while a change builds (R11.6)', () => {
  it('the changes list opens while another change builds', async () => {
    const { fixture, container } = await render(SdlcToolbar, inputs({ crumbs: ['c1'], back: 'Changes' }));
    // A running build never reaches the toolbar: it has no lock input, and every control stays enabled.
    expect('locked' in fixture.componentInstance).toBe(false);
    const went: string[] = [];
    fixture.componentInstance.goBack.subscribe(() => went.push('back'));
    fixture.componentInstance.switchMode.subscribe(() => went.push('mode'));
    fixture.componentInstance.openSettings.subscribe(() => went.push('settings'));
    for (const label of ['Back to the changes list', 'Switch mode (ai-sdlc)', 'AI-SDLC settings']) {
      expect(byLabel(container, label).disabled, label).toBe(false);
      byLabel(container, label).click();
    }
    expect(went).toEqual(['back', 'mode', 'settings']);
    expect(switcher(container).disabled).toBe(false);
  });
});
