import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { render } from '../../../testing/render';
import type { ChangeView } from '@bindings/ChangeView';
import { SdlcRunner } from '../../core/sdlc/sdlc-runner';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_MASTER } from '../../lib/sdlc-mock';
import { ChangePage } from './change-page';

const NEW_NAME = 'feat/PROJ-123-password-reset';
const REASON = 'A run of this change is live; rename its branch after it ends.';

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    TestBed.tick();
    await new Promise((r) => setTimeout(r, 0));
  }
};

/** The backend's offer for the change, with the rename action as the test says: absent, offered, or refused with a reason. */
function offering(transport: MockTransport, rename: 'absent' | 'offered' | 'refused') {
  const real = transport.sdlcChangeState.bind(transport);
  vi.spyOn(transport, 'sdlcChangeState').mockImplementation(async (...args): Promise<ChangeView> => {
    const view = await real(...args);
    const others = view.offer.actions.filter((a) => a.action !== 'rename');
    const action = { action: 'rename' as const, enabled: rename === 'offered', reason: rename === 'refused' ? REASON : null, feedbackRequired: false, revisits: false };
    return { ...view, offer: { ...view.offer, actions: rename === 'absent' ? others : [...others, action] } };
  });
}

async function mount(transport: MockTransport) {
  const out = await render(ChangePage, {}, [
    provideRouter([]),
    { provide: KataTransport, useValue: transport },
    { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ system: 'commerce', change: MOCK_BUILD_CHANGE })), snapshot: { queryParamMap: convertToParamMap({}) } } },
  ]);
  await settle();
  return out;
}

const renameButton = (root: HTMLElement) => Array.from(root.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Rename branch') ?? null;

describe.each(['plan-awaiting', 'build-finished'] as const)('renaming from the change page at %s', (stage) => {
  afterEach(() => vi.restoreAllMocks());

  function staged(rename: 'absent' | 'offered' | 'refused') {
    const transport = new MockTransport();
    transport.patchChange(MOCK_BUILD_CHANGE, { stage });
    vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({ files: [], loc: [] });
    offering(transport, rename);
    return transport;
  }

  it('offers Rename when the backend offers it', async () => {
    const { container } = await mount(staged('offered'));
    const button = renameButton(container as HTMLElement);
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
  });

  it('offers nothing to rename when the backend does not list it', async () => {
    const { container } = await mount(staged('absent'));
    expect(renameButton(container as HTMLElement)).toBeNull();
  });

  it('shows Rename off with the backend reason while a run is live (R2.4)', async () => {
    const { container } = await mount(staged('refused'));
    const button = renameButton(container as HTMLElement);
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute('title')).toBe(REASON);
  });

  it('a rename through it shows the new branch and lists the pull requests opened from the old name (R2.3)', async () => {
    const transport = staged('offered');
    let renamed = false;
    const repos = transport.sdlcChangeRepos.bind(transport);
    vi.spyOn(transport, 'sdlcChangeRepos').mockImplementation(async (...args) =>
      (await repos(...args)).map((r) => (r.repo === MOCK_MASTER && renamed ? { ...r, branch: NEW_NAME } : r)),
    );
    const old = { repo: 'commerce-core', url: 'https://github.com/acme/commerce-core/pull/3', number: 3, source: 'plugin' as const };
    const rename = vi.spyOn(transport, 'sdlcRenameBranch').mockImplementation(async () => {
      renamed = true;
      return { outcome: 'renamed', from: `change/${MOCK_BUILD_CHANGE}`, to: NEW_NAME, repos: ['master'], oldPullRequests: [old] };
    });
    const { container } = await mount(transport);
    renameButton(container as HTMLElement)!.click();
    await settle();
    // The branch dialog opens on the change's current branch.
    expect(TestBed.inject(SdlcRunner).nameRequest()?.current).toBe(`change/${MOCK_BUILD_CHANGE}`);
    await TestBed.inject(SdlcRunner).confirmName(NEW_NAME);
    await settle();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename.mock.calls[0].slice(2)).toEqual(['commerce', MOCK_BUILD_CHANGE, NEW_NAME]);
    // The pull requests opened from the old name are listed to close by hand, with their address.
    const text = document.body.textContent!;
    expect(text).toContain('Left behind under an earlier name');
    expect(text).toContain(old.url);
    expect(text).toContain(`change/${MOCK_BUILD_CHANGE}`);
    // The page read the change again: the new branch is what it knows.
    expect(transport.sdlcChangeRepos).toHaveBeenCalledTimes(2);
  });
});
