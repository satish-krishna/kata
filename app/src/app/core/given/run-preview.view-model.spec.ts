import { TestBed } from '@angular/core/testing';
import type { RunSpec } from '@bindings/RunSpec';
import { SECOND_REPO, SECOND_REPO_PLUGIN, seedSpec } from '../../lib/mock';
import { presetRows } from '../../lib/given';
import { previewFixture } from '../../lib/mock';
import type { KindGroup, PresetRow } from '../../lib/given';
import { KataTransport } from '../transport/kata-transport';
import { MockTransport } from '../transport/mock-transport';
import { GivenStore } from './given.store';
import { RunPreviewViewModel, sharedRows, type BuildPart, type BuildPreviewRequest, type PreviewRequest } from './run-preview.view-model';

const SUPERPOWERS = 'personal:plugin:superpowers@claude-plugins-official';
const GITHUB = 'personal:tool-server:github';

function setup() {
  TestBed.configureTestingModule({ providers: [RunPreviewViewModel, { provide: KataTransport, useClass: MockTransport }] });
  const vm = TestBed.inject(RunPreviewViewModel);
  const store = TestBed.inject(GivenStore);
  const spec = seedSpec();
  const req = (over: Partial<PreviewRequest> = {}): PreviewRequest => ({
    spec,
    mode: 'run',
    workdir: spec.workdir,
    from: { session: store.session(), job: null, build: null },
    ...over,
  });
  return { vm, store, spec, req };
}
const flat = (groups: KindGroup[]): PresetRow[] =>
  groups.flatMap((k) => k.groups.flatMap((g) => g.rows.flatMap((e) => [e.row, ...e.followers])));
const rowOf = (vm: RunPreviewViewModel, id: string) => flat(vm.groups()).find((r) => r.item.id === id)!;
const opened = async (vm: RunPreviewViewModel) => vi.waitFor(() => expect(vm.groups().length).toBeGreaterThan(0));

describe('RunPreviewViewModel', () => {
  it('switching a plugin off takes what it brings', async () => {
    const { vm, req } = setup();
    void vm.open(req());
    await opened(vm);
    const followers = flat(vm.groups()).filter((r) => r.item.brought_by === SUPERPOWERS);
    expect(followers.length).toBeGreaterThanOrEqual(3);
    expect(followers.every((r) => !r.off)).toBe(true);
    vm.toggle(rowOf(vm, SUPERPOWERS).key, true);
    expect(rowOf(vm, SUPERPOWERS).off).toBe(true);
    for (const f of followers) expect(rowOf(vm, f.item.id).off).toBe(true);
    // None of them can be switched back on while the plugin is off.
    for (const f of followers) vm.toggle(f.key, false);
    for (const f of followers) expect(rowOf(vm, f.item.id).off).toBe(true);
    vm.toggle(rowOf(vm, SUPERPOWERS).key, false);
    for (const f of followers) expect(rowOf(vm, f.item.id).off).toBe(false);
  });

  it('a hook switched back on is given', async () => {
    const { vm, req } = setup();
    const done = vm.open(req());
    await opened(vm);
    // Hooks are locked in this build, so a hook cannot be switched off at all.
    const hook = flat(vm.groups()).find((r) => r.item.kind === 'hook' && r.item.source === 'personal')!;
    vm.toggle(hook.key, true);
    expect(rowOf(vm, hook.item.id).off).toBe(false);
    // An item that can be switched: off, then on again, is given.
    vm.toggle(GITHUB, true);
    expect(rowOf(vm, GITHUB).off).toBe(true);
    vm.toggle(GITHUB, false);
    vm.start();
    const spec = (await done) as RunSpec;
    expect(spec.given!.tool_servers).not.toContain(GITHUB);
    expect(spec.given!.hooks).not.toContain(hook.item.id);
  });

  it('start remembers the choices; cancel remembers nothing', async () => {
    const a = setup();
    const done = a.vm.open(a.req());
    await opened(a.vm);
    a.vm.toggle(GITHUB, true);
    a.vm.start();
    const spec = (await done) as RunSpec;
    expect(spec.given!.tool_servers).toEqual([GITHUB]);
    expect([...a.store.session()]).toEqual([GITHUB]);
    expect(a.vm.isOpen()).toBe(false);

    TestBed.resetTestingModule();
    const b = setup();
    const cancelled = b.vm.open(b.req());
    await opened(b.vm);
    b.vm.toggle(GITHUB, true);
    b.vm.cancel();
    expect(await cancelled).toBeNull();
    expect([...b.store.session()]).toEqual([]);
    expect(b.vm.isOpen()).toBe(false);
  });

  it('shows the settings, the variable names and the warnings of the preview', async () => {
    const { vm, spec, req } = setup();
    void vm.open(req({ spec: { ...spec, model: { ...spec.model, id: null }, leash: { ...spec.leash, max_turns: null } } }));
    await opened(vm);
    const model = vm.settings().find((s) => s.label === 'Model')!;
    expect(model.source).toBe("Claude's default");
    expect(vm.settings().find((s) => s.label === 'Turn cap')!.value).toBe('none');
    expect(vm.env().map((e) => e.name)).toEqual(['GITHUB_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(vm.env().find((e) => e.name === 'ANTHROPIC_API_KEY')!.apiKey).toBe(true);
    expect(vm.warnings()).toEqual([]);
  });

  it('an SDLC run locks the ai-sdlc plugin its spec requires', async () => {
    const { vm, req, spec } = setup();
    const required = { ...spec, given: { hooks: [], skills: [], plugins: [], instructions: [], tool_servers: [], required_plugins: ['ai-sdlc'] } };
    void vm.open(req({ mode: 'sdlc', spec: required }));
    await opened(vm);
    expect(rowOf(vm, 'personal:plugin:ai-sdlc@ai-sdlc').locked?.kind).toBe('required');
  });

  describe('a build with two repositories', () => {
    const EXTRA = `personal:plugin:${SECOND_REPO_PLUGIN}`;
    function build() {
      const { vm, store, spec } = setup();
      const sections = [
        { title: 'acme-api', repo: 'acme-api', spec: { ...spec, workdir: 'D:/Repos/acme-api' }, workdir: 'D:/Repos/acme-api' },
        { title: SECOND_REPO, repo: SECOND_REPO, spec: { ...spec, workdir: `D:/Repos/${SECOND_REPO}` }, workdir: `D:/Repos/${SECOND_REPO}` },
      ];
      const req: BuildPreviewRequest = { title: 'Start the build', kind: 'start', sections, from: { session: store.session(), job: null, build: null }, limitSecs: 1800 };
      return { vm, sections, req };
    }

    it('shared rows come from every repository', async () => {
      const { vm, sections, req } = build();
      void vm.openBuild(req);
      await opened(vm);
      const ids = flat(vm.groups()).map((r) => r.item.id);
      // The second repository's personal plugin is listed once, although the first does not have it.
      expect(ids.filter((id) => id === EXTRA)).toHaveLength(1);
      expect(ids).toContain(GITHUB);
      // The helper alone: first section's order, then rows first seen later, none bound to a project.
      const parts: BuildPart[] = sections.map((section) => ({ section, rows: presetRows(previewFixture(section.spec), { session: new Set(), job: null, build: null, workdir: section.workdir }).rows }));
      const shared = sharedRows(parts);
      const firstOnly = shared.slice(0, parts[0].rows.filter((r) => r.key === r.item.id).length);
      expect(shared.map((r) => r.key)).toContain(EXTRA);
      expect(shared.every((r) => r.key === r.item.id || r.item.brought_by !== null)).toBe(true);
      expect(shared[shared.length - 1].key).toBe(EXTRA);
      expect(new Set(shared.map((r) => r.key)).size).toBe(shared.length);
      expect(firstOnly.length).toBeGreaterThan(0);
    });

    it('a choice on a shared row reaches every section that lists it', async () => {
      const { vm, req } = build();
      const done = vm.openBuild(req);
      await opened(vm);
      vm.toggle(EXTRA, true);
      vm.toggle(GITHUB, true);
      expect(rowOf(vm, EXTRA).off).toBe(true);
      expect(rowOf(vm, GITHUB).off).toBe(true);
      vm.start();
      const result = (await done)!;
      expect([...result.off]).toEqual(expect.arrayContaining([EXTRA, GITHUB]));
    });
  });

  describe('the start button label', () => {
    const finding = (id: string, repo: string) => ({ key: id, finding: { severity: 'high' as const, text: `fix ${id}`, id, repo }, repo });
    const offer = { review: 1, repos: ['acme-api', SECOND_REPO], findings: [finding('F1', 'acme-api'), finding('F2', SECOND_REPO)] };
    function preview(kind: 'round' | 'start') {
      const { vm, store, spec } = setup();
      const sections = [
        { title: 'acme-api', repo: 'acme-api', spec: { ...spec, workdir: 'D:/Repos/acme-api' }, workdir: 'D:/Repos/acme-api' },
        { title: SECOND_REPO, repo: SECOND_REPO, spec: { ...spec, workdir: `D:/Repos/${SECOND_REPO}` }, workdir: `D:/Repos/${SECOND_REPO}` },
      ];
      const req: BuildPreviewRequest = { title: 'Start round', kind, sections, from: { session: store.session(), job: null, build: null }, limitSecs: 1800, offer: kind === 'round' ? offer : null };
      void vm.openBuild(req);
      return vm;
    }
    const unpick = (vm: RunPreviewViewModel, key: string) =>
      vm.buildForm()!.model.update((m) => ({ ...m, picked: m.picked.filter((k) => k !== key) }));

    it('counts the agents of a round', async () => {
      const vm = preview('round');
      await opened(vm);
      expect(vm.startLabel()).toBe('Start 2 agents');
      unpick(vm, 'F2');
      expect(vm.startLabel()).toBe('Start 1 agent');
      unpick(vm, 'F1');
      expect(vm.startLabel()).toBe('Start agents');
    });

    it('stays Start run for a plain build preview', async () => {
      const vm = preview('start');
      await opened(vm);
      expect(vm.startLabel()).toBe('Start run');
    });
  });
});
