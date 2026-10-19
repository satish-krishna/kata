import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import { render } from '../../testing/render';
import { SdlcToolbar } from './sdlc-toolbar';

const WS: WorkspaceEntry = { id: 'acme', name: 'acme-claims', folder: '/a', base_branch: 'main', last_opened: 1 };
const inputs = (over: Record<string, unknown> = {}) => ({
  workspaces: [WS], current: WS, missing: [], counts: {}, branch: 'main', locked: false, ...over,
});
const byLabel = (c: HTMLElement, label: string) => c.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

describe('SdlcToolbar', () => {
  it('shows the ai-sdlc badge, the workspace, and the master branch in mono', async () => {
    const { container } = await render(SdlcToolbar, inputs());
    expect(byLabel(container, 'Switch mode (ai-sdlc)').textContent!.trim()).toBe('ai-sdlc');
    expect(container.textContent).toContain('acme-claims');
    expect(container.querySelector('[data-testid="branch"]')!.textContent!.trim()).toBe('main');
  });

  it('hides the branch while the master repo has none to show', async () => {
    const { container } = await render(SdlcToolbar, inputs({ branch: null }));
    expect(container.querySelector('[data-testid="branch"]')).toBeNull();
  });

  it('shows the breadcrumb after the workspace', async () => {
    const { container } = await render(SdlcToolbar, inputs({ crumbs: ['claims', '2026-10-12-fnol'] }));
    expect(container.querySelector('nav')!.textContent).toContain('2026-10-12-fnol');
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

  it('disables the mode badge and settings while locked', async () => {
    const { container } = await render(SdlcToolbar, inputs({ locked: true }));
    expect(byLabel(container, 'Switch mode (ai-sdlc)').disabled).toBe(true);
    expect(byLabel(container, 'AI-SDLC settings').disabled).toBe(true);
  });

  it('has Add workspace and a Remove button named for the workspace, which emit', async () => {
    const { fixture, container } = await render(SdlcToolbar, inputs());
    const got: string[] = [];
    fixture.componentInstance.add.subscribe(() => got.push('add'));
    fixture.componentInstance.remove.subscribe(() => got.push('remove'));
    byLabel(container, 'Add workspace').click();
    byLabel(container, 'Remove acme-claims from list').click();
    expect(got).toEqual(['add', 'remove']);
  });

  it('cannot remove when there is no current workspace', async () => {
    const { container } = await render(SdlcToolbar, inputs({ current: null, workspaces: [] }));
    expect(container.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(byLabel(container, 'Add workspace')).not.toBeNull();
  });

  it('withholds the workspace switcher and branch while blocked', async () => {
    const { container } = await render(SdlcToolbar, inputs({ blocked: true }));
    expect(container.querySelector('button[aria-label="Switch workspace"]')).toBeNull();
    expect(container.querySelector('[data-testid="branch"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Add workspace"]')).toBeNull();
    expect(byLabel(container, 'Switch mode (ai-sdlc)')).not.toBeNull();
  });

  it('projects the primary action', async () => {
    @Component({
      imports: [SdlcToolbar],
      template: `<app-sdlc-toolbar [workspaces]="[]" [current]="null" [missing]="[]" [counts]="{}" [branch]="null">
        <span id="primary">New change</span>
      </app-sdlc-toolbar>`,
    })
    class Host {}
    TestBed.configureTestingModule({ imports: [Host], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('#primary')).not.toBeNull();
  });
});
