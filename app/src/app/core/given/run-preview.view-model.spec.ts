import { TestBed } from '@angular/core/testing';
import type { RunSpec } from '@bindings/RunSpec';
import { seedSpec } from '../../lib/mock';
import type { KindGroup, PresetRow } from '../../lib/given';
import { KataTransport } from '../transport/kata-transport';
import { MockTransport } from '../transport/mock-transport';
import { GivenStore } from './given.store';
import { RunPreviewViewModel, type PreviewRequest } from './run-preview.view-model';

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
    void vm.open(req({ spec: { ...spec, model: { ...spec.model, id: null } } }));
    await opened(vm);
    const model = vm.settings().find((s) => s.label === 'Model')!;
    expect(model.source).toBe("Claude's default");
    expect(vm.settings().find((s) => s.label === 'Turn cap')!.value).toBe('none');
    expect(vm.env().map((e) => e.name)).toEqual(['GITHUB_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(vm.env().find((e) => e.name === 'ANTHROPIC_API_KEY')!.apiKey).toBe(true);
    expect(vm.warnings()).toEqual([]);
  });

  it('an SDLC run locks the ai-sdlc plugin', async () => {
    const { vm, req } = setup();
    void vm.open(req({ mode: 'sdlc' }));
    await opened(vm);
    expect(rowOf(vm, 'personal:plugin:ai-sdlc').locked?.kind).toBe('required');
  });
});
