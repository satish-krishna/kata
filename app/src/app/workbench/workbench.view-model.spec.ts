import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { WorkbenchViewModel } from './workbench.view-model';
import { RunPreviewViewModel } from '../core/given/run-preview.view-model';
import { GivenStore } from '../core/given/given.store';
import { MockTransport } from '../core/transport/mock-transport';
import { KataTransport } from '../core/transport/kata-transport';
import { RunStore } from '../core/run/run.store';
import { toastState } from '@spartan-ng/brain/sonner';
import { LaunchStore } from '../core/launch/launch.store';
import { seedSpec, seedCatalog, previewFixture } from '../lib/mock';
import type { RunSpec } from '@bindings/RunSpec';
import { toGiven, type PresetRow } from '../lib/given';
import { defaultSpec, draftFrom, normalize } from '../lib/spec';
import type { KataEvent } from '../lib/events';

class FakeTransport {
  listeners: ((ev: KataEvent) => void)[] = [];
  onRunEvent(cb: (runId: string, ev: KataEvent) => void) {
    this.listeners.push((ev) => cb('1', ev));
    return Promise.resolve(() => {});
  }
  runSpec = vi.fn(() => Promise.resolve('1'));
  cancelRun = vi.fn(() => Promise.resolve());
  submitAnswer = vi.fn(() => Promise.resolve());
  submitDecision = vi.fn(() => Promise.resolve());
  catalog = vi.fn(() => Promise.resolve(seedCatalog));
  listPresets = vi.fn(() => Promise.resolve([]));
  validateSpec = vi.fn(() => Promise.resolve([] as string[]));
  loadSpec = vi.fn();
  saveSpec = vi.fn(() => Promise.resolve());
  saveKata = vi.fn((_spec: RunSpec) => Promise.resolve());
  previewRun = vi.fn((spec: RunSpec) => Promise.resolve(previewFixture(spec)));
  savePreset = vi.fn(() => Promise.resolve());
  exportBundle = vi.fn(() => Promise.resolve());
  pickOpenSpec = vi.fn(() => Promise.resolve(null as string | null));
  pickSaveSpec = vi.fn(() => Promise.resolve(null as string | null));
  pickDirectory = vi.fn(() => Promise.resolve(null as string | null));
}

function setup() {
  const fake = new FakeTransport();
  TestBed.configureTestingModule({
    providers: [WorkbenchViewModel, RunPreviewViewModel, { provide: KataTransport, useValue: fake }, provideRouter([])],
  });
  return { vm: TestBed.inject(WorkbenchViewModel), fake, store: TestBed.inject(RunStore) };
}

const TAURI = '__TAURI_INTERNALS__';
const ctrlEnter = () => new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true });
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const confirmReady = (vm: WorkbenchViewModel) => vi.waitFor(() => expect(vm.preview.isOpen() && !vm.preview.busy()).toBe(true));
/** Wait for the preview to finish loading, then press Start run. */
const confirm = async (vm: WorkbenchViewModel) => {
  await confirmReady(vm);
  vm.preview.start();
};
const toastText = () =>
  toastState
    .toasts()
    .map((t) => String(t.title))
    .join(' ');

afterEach(() => toastState.reset());

it('starts from seedSpec in the browser and from defaultSpec under Tauri, where demo is ignored', async () => {
  const a = setup();
  await a.vm.init(false);
  expect(a.vm.spec()).toEqual(seedSpec());
  expect(a.vm.dirty()).toBe(false);
  TestBed.resetTestingModule();
  (window as unknown as Record<string, unknown>)[TAURI] = {};
  try {
    const b = setup();
    await b.vm.init(true);
    expect(b.vm.spec()).toEqual(defaultSpec());
    expect(b.fake.runSpec).not.toHaveBeenCalled();
  } finally {
    delete (window as unknown as Record<string, unknown>)[TAURI];
  }
});

it('runs the demo once on init when demo=true in the browser', async () => {
  const { vm, fake } = setup();
  const init = vm.init(true);
  await confirm(vm);
  await init;
  expect(fake.runSpec).toHaveBeenCalledTimes(1);
});

it('does not start a second run on Ctrl+Enter while one is active (Review Focus #5)', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  vm.onKey(ctrlEnter());
  vm.onKey(ctrlEnter());
  await confirm(vm);
  await vi.waitFor(() => expect(fake.runSpec).toHaveBeenCalledTimes(1));
  vm.onKey(ctrlEnter());
  await settle();
  expect(fake.runSpec).toHaveBeenCalledTimes(1);
});

it('ignores Ctrl+Enter while a dialog is open (Review Focus #5)', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  vm.spec.update((s) => ({ ...s, task: 'changed' }));
  vm.newSpec();
  expect(vm.confirmOpen()).toBe(true);
  vm.onKey(ctrlEnter());
  await settle();
  expect(fake.runSpec).not.toHaveBeenCalled();
});

it('ignores a bare Enter and prevents default on Ctrl+Enter', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  vm.onKey(new KeyboardEvent('keydown', { key: 'Enter' }));
  await settle();
  expect(fake.runSpec).not.toHaveBeenCalled();
  const ev = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true });
  vm.onKey(ev);
  expect(ev.defaultPrevented).toBe(true);
});

it('round-trips hidden fields and clears dirty after save (Review Focus #3)', async () => {
  const { vm, fake } = setup();
  const onDisk = { ...seedSpec(), plugins: { gh: { mcp: true, env: ['A', 'B'] } }, auth: { bare: false, token_env: 'TOK' } };
  fake.pickOpenSpec.mockResolvedValue('x.toml');
  fake.loadSpec.mockResolvedValue(onDisk);
  await vm.init(false);
  await vm.open();
  expect(vm.dirty()).toBe(false);
  vm.form.task().value.set('edited');
  expect(vm.dirty()).toBe(true);
  await vm.save();
  // Save writes through saveKata (as the original page did), carrying the fields the form never shows.
  // Saving always writes a given section, empty when no preview chose anything.
  expect(fake.saveKata).toHaveBeenCalledWith({ ...normalize({ ...draftFrom(onDisk), task: 'edited' }), given: toGiven([]) });
  const saved = fake.saveKata.mock.calls[0] as unknown as [typeof onDisk];
  expect(saved[0].plugins).toEqual(onDisk.plugins);
  expect(saved[0].auth.token_env).toBe('TOK');
  expect(vm.dirty()).toBe(false);
});

it('keeps dirty set when save fails and toasts', async () => {
  const { vm, fake } = setup();
  fake.saveKata.mockRejectedValue(new Error('disk full'));
  await vm.init(false);
  vm.form.task().value.set('edited');
  await vm.save();
  expect(vm.dirty()).toBe(true);
  expect(toastText()).toContain('disk full');
});

it('takes a Library launch once and auto-runs it', async () => {
  const { vm, fake } = setup();
  const spec = { ...seedSpec(), name: 'from-library' };
  TestBed.inject(LaunchStore).set({ spec, autorun: true });
  const init = vm.init(false);
  await confirm(vm);
  await init;
  expect(vm.spec().name).toBe('from-library');
  expect(vm.dirty()).toBe(false);
  expect(fake.runSpec).toHaveBeenCalledTimes(1);
  expect(TestBed.inject(LaunchStore).take()).toBeNull();
});

it('loads a Library launch without running it when autorun is off', async () => {
  const { vm, fake } = setup();
  TestBed.inject(LaunchStore).set({ spec: { ...seedSpec(), name: 'quiet' }, autorun: false });
  await vm.init(false);
  expect(vm.spec().name).toBe('quiet');
  expect(fake.runSpec).not.toHaveBeenCalled();
});

it('toasts a failed open', async () => {
  const { vm, fake } = setup();
  fake.pickOpenSpec.mockResolvedValue('x.toml');
  fake.loadSpec.mockRejectedValue(new Error('bad toml'));
  await vm.init(false);
  await vm.open();
  expect(toastText()).toContain('bad toml');
});

it('changes nothing when the open picker is cancelled', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  await vm.open();
  expect(fake.loadSpec).not.toHaveBeenCalled();
  expect(vm.spec()).toEqual(seedSpec());
});

it('blocks a run and shows errors when validation fails', async () => {
  const { vm, fake } = setup();
  fake.validateSpec.mockResolvedValue(['task is required']);
  await vm.init(false);
  await vi.waitFor(() => expect(vm.errors()).toEqual(['task is required']));
  await vm.run();
  expect(vm.valid()).toBe(false);
  expect(fake.runSpec).not.toHaveBeenCalled();
});

it('guards New behind a discard confirm only when dirty, and discards on confirm', async () => {
  const { vm } = setup();
  await vm.init(false);
  vm.newSpec();
  expect(vm.confirmOpen()).toBe(false);
  expect(vm.spec()).toEqual(defaultSpec());
  vm.form.task().value.set('x');
  vm.newSpec();
  expect(vm.confirmOpen()).toBe(true);
  vm.cancelDiscard();
  expect(vm.confirmOpen()).toBe(false);
  expect(vm.spec().task).toBe('x');
  vm.newSpec();
  vm.confirmDiscard();
  expect(vm.confirmOpen()).toBe(false);
  expect(vm.spec()).toEqual(defaultSpec());
  expect(vm.dirty()).toBe(false);
});

it('exports the normalized spec to the picked directory, and does nothing on a cancelled picker', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  await vm.export();
  expect(fake.exportBundle).not.toHaveBeenCalled();
  fake.pickDirectory.mockResolvedValue('/out');
  await vm.export();
  expect(fake.exportBundle).toHaveBeenCalledWith(normalize(seedSpec()), '/out');
});

it('toasts a failed export', async () => {
  const { vm, fake } = setup();
  fake.pickDirectory.mockResolvedValue('/out');
  fake.exportBundle.mockRejectedValue(new Error('nope'));
  await vm.init(false);
  await vm.export();
  expect(toastText()).toContain('nope');
});

it('writes the picked workdir into the form, and ignores a cancelled picker', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  await vm.pickWorkdir();
  expect(vm.spec().workdir).toBe(seedSpec().workdir);
  fake.pickDirectory.mockResolvedValue('/work');
  await vm.pickWorkdir();
  expect(vm.spec().workdir).toBe('/work');
});

it('saves a preset then refreshes the list; toasts on failure', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  fake.listPresets.mockResolvedValue([{ name: 'p', body: 'b' }] as never);
  await vm.savePreset({ name: 'p', body: 'b' });
  expect(fake.savePreset).toHaveBeenCalledWith('p', 'b');
  expect(vm.presets()).toEqual([{ name: 'p', body: 'b' }]);
  fake.savePreset.mockRejectedValue(new Error('exists'));
  await vm.savePreset({ name: 'p', body: 'b' });
  expect(toastText()).toContain('exists');
});

it('loads the catalog and live validation errors after the debounce', async () => {
  const { vm, fake } = setup();
  fake.validateSpec.mockResolvedValue(['bad']);
  await vm.init(false);
  TestBed.tick();
  await vi.waitFor(() => expect(vm.catalog()).toEqual(seedCatalog));
  await vi.waitFor(() => expect(vm.errors()).toEqual(['bad']));
});

it('forwards answers and decisions to the run store', async () => {
  const { vm, store } = setup();
  await vm.init(false);
  const answer = vi.spyOn(store, 'submitAnswer');
  const decide = vi.spyOn(store, 'submitDecision');
  vm.answer({ id: 'a', answers: [['x']] });
  vm.decide({ id: 'p', allow: true, message: null });
  expect(answer).toHaveBeenCalledWith('a', [['x']]);
  expect(decide).toHaveBeenCalledWith('p', true, null);
});

it('ignores Ctrl+Enter while the save-preset prompt is open (R22)', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  vm.setNaming(true);
  vm.onKey(ctrlEnter());
  await settle();
  expect(fake.runSpec).not.toHaveBeenCalled();
  vm.setNaming(false);
  vm.onKey(ctrlEnter());
  await confirm(vm);
  await vi.waitFor(() => expect(fake.runSpec).toHaveBeenCalledTimes(1));
});

it('toasts instead of rejecting when the Library autorun validation throws', async () => {
  const { vm, fake } = setup();
  fake.validateSpec.mockRejectedValue(new Error('engine down'));
  TestBed.inject(LaunchStore).set({ spec: seedSpec(), autorun: true });
  await vm.init(false);
  expect(fake.runSpec).not.toHaveBeenCalled();
  expect(toastText()).toContain('engine down');
});

it('does not autorun a Library spec that fails fresh validation', async () => {
  const { vm, fake } = setup();
  fake.validateSpec.mockResolvedValue(['task is required']);
  TestBed.inject(LaunchStore).set({ spec: seedSpec(), autorun: true });
  await vm.init(false);
  expect(vm.errors()).toEqual(['task is required']);
  expect(fake.runSpec).not.toHaveBeenCalled();
});

describe('the preview before a run', () => {
  const HOOK_GONE = 'personal:hook:RemovedHook:0123456789abcdef';
  const DOC_WRITER = 'run-spec:skill:doc-writer';

  function mockSetup() {
    TestBed.configureTestingModule({
      providers: [WorkbenchViewModel, RunPreviewViewModel, { provide: KataTransport, useClass: MockTransport }, provideRouter([])],
    });
    const transport = TestBed.inject(KataTransport);
    return {
      vm: TestBed.inject(WorkbenchViewModel),
      runSpec: vi.spyOn(transport, 'runSpec'),
      saveKata: vi.spyOn(transport, 'saveKata'),
    };
  }
  const rows = (vm: WorkbenchViewModel): PresetRow[] =>
    vm.preview.groups().flatMap((k) => k.groups.flatMap((g) => g.rows.flatMap((e) => [e.row, ...e.followers])));
  const rowOf = (vm: WorkbenchViewModel, id: string) => rows(vm).find((r) => r.item.id === id)!;

  it('closing the preview starts nothing and changes nothing', async () => {
    const { vm, runSpec } = mockSetup();
    await vm.init(false);
    const spec = structuredClone(vm.spec());
    const dirty = vm.dirty();
    const session = TestBed.inject(GivenStore).session();
    const run = vm.run();
    await confirmReady(vm);
    vm.preview.toggle(DOC_WRITER, true);
    vm.preview.cancel();
    await run;
    expect(vm.preview.isOpen()).toBe(false);
    expect(runSpec).not.toHaveBeenCalled();
    expect(vm.spec()).toEqual(spec);
    expect(vm.dirty()).toBe(dirty);
    expect(TestBed.inject(GivenStore).session()).toBe(session);
    expect(session.size).toBe(0);
  });

  it('a saved job keeps its choices and its rerun shows them', async () => {
    const first = mockSetup();
    await first.vm.init(false);
    const run = first.vm.run();
    await confirmReady(first.vm);
    first.vm.preview.toggle(DOC_WRITER, true);
    first.vm.preview.start();
    await run;
    await first.vm.save();
    const saved = first.saveKata.mock.calls[0][0];
    expect(saved.given?.skills).toEqual([DOC_WRITER]);

    // The Library hands the saved job over; a fresh Workbench with a fresh session picks it up.
    TestBed.resetTestingModule();
    const second = mockSetup();
    TestBed.inject(LaunchStore).set({ spec: saved, autorun: true });
    const init = second.vm.init(false);
    await confirmReady(second.vm);
    expect(rowOf(second.vm, DOC_WRITER)).toMatchObject({ off: true, mark: 'job' });
    second.vm.preview.cancel();
    await init;
    expect(second.runSpec).not.toHaveBeenCalled();
  });

  it('a rerun warns about a switched-off item that is gone and still starts', async () => {
    const { vm, runSpec } = mockSetup();
    const given = { hooks: [HOOK_GONE], skills: [], plugins: [], instructions: [], tool_servers: [] };
    TestBed.inject(LaunchStore).set({ spec: { ...seedSpec(), given }, autorun: false });
    await vm.init(false);
    const run = vm.run();
    await confirmReady(vm);
    expect(vm.preview.warnings().join(' ')).toContain('RemovedHook');
    vm.preview.start();
    await run;
    expect(runSpec).toHaveBeenCalledTimes(1);
    expect(runSpec.mock.calls[0][0].given?.hooks).toEqual([]);
  });

  it("the run's limits are the job's", async () => {
    const { vm, runSpec } = mockSetup();
    await vm.init(false);
    vm.form.leash().value.set({ ...vm.spec().leash, max_turns: 7, timeout_secs: 600 });
    const run = vm.run();
    await confirmReady(vm);
    const shown = Object.fromEntries(vm.preview.settings().map((s) => [s.label, s.value]));
    expect(shown['Turn cap']).toBe('7');
    expect(shown['Time limit']).toBe('10 min');
    vm.preview.start();
    await run;
    expect(runSpec.mock.calls[0][0].leash).toMatchObject({ max_turns: 7, timeout_secs: 600 });
  });
});
