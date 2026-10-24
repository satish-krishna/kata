import { Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LockStore } from '../../core/lock/lock.store';
import { ToastStore } from '../../core/toast/toast.store';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { defaultArrangement, type AreaId, type LayoutMode } from '../../lib/build-layout';
import { readLayoutFile } from '../../lib/build-layout-file';
import type { LayoutStage } from '../../lib/build-layout-stage';
import { BuildLayoutViewModel } from './build-layout.view-model';
import { BuildPageViewModel } from './build-page.view-model';

const BIG = { width: 1600, height: 900 };
const UNREADABLE_WATCH = 'The Watch layout could not be read; it is back to its default.';

/** The part of the build page's view model the layout reads, as writable signals. */
function makeStandIn(stage: LayoutStage) {
  const announcement = signal('');
  return {
    loaded: signal<{ ctx: { change: string } } | null>(null),
    layoutStage: signal<LayoutStage>(stage),
    announcement,
    say: (text: string) => announcement.set(text),
    groups: signal<{ key: string }[]>([{ key: 'repo' }]),
    sessions: signal<{ id: string }[]>([{ id: 's1' }]),
    findings: signal<{ title: string }[]>([{ title: 'f1' }]),
    waitingNotices: signal<{ repo: string }[]>([]),
    buildRows: signal<{ task: string }[]>([]),
    changedFiles: signal(false),
  };
}

/** A layout view model over a transport, with its own stand-in for the build page; it has read the file when this returns. */
async function make(transport: MockTransport, stage: LayoutStage = 'running') {
  const standIn = makeStandIn(stage);
  const injector = Injector.create({
    providers: [{ provide: KataTransport, useValue: transport }, { provide: BuildPageViewModel, useValue: standIn }, BuildLayoutViewModel],
    parent: TestBed.inject(Injector),
  });
  const vm = injector.get(BuildLayoutViewModel);
  vm.room.set(BIG);
  await flush();
  return { vm, standIn };
}

/** Lets the file read, the writes and the effects settle. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
}

function setup() {
  const transport = new MockTransport();
  TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useValue: transport }] });
  return transport;
}

const stored = async (transport: MockTransport) => readLayoutFile(await transport.loadBuildLayout());

describe('BuildLayoutViewModel', () => {
  it('R5.6: arranging Watch leaves Overview at its default', async () => {
    const { vm } = await make(setup());
    vm.open('A');
    vm.arrange({ kind: 'place', area: 'activity', to: 'left' });
    expect(vm.arrangement().left).toEqual(['activity']);
    vm.pickMode('overview');
    expect(vm.mode()).toBe('overview');
    expect(vm.arrangement()).toEqual(defaultArrangement('overview'));
  });

  it('R7.4: focus is never saved and a new view model opens without it', async () => {
    const transport = setup();
    const { vm } = await make(transport);
    vm.open('A');
    const save = vi.spyOn(transport, 'saveBuildLayout');
    vm.focusOn('activity');
    await flush();
    expect(vm.focus()).toBe('activity');
    expect(save).not.toHaveBeenCalled();
    const second = await make(transport);
    second.vm.open('A');
    expect(second.vm.focus()).toBeNull();
  });

  it('R8.1: an arrangement survives a restart', async () => {
    const transport = setup();
    const first = await make(transport);
    first.vm.open('A');
    first.vm.arrange({ kind: 'place', area: 'activity', to: 'left' });
    first.vm.arrange({ kind: 'resize', side: 'left', px: 420 });
    await flush();
    const second = await make(transport);
    second.vm.open('A');
    expect(second.vm.mode()).toBe('watch');
    expect(second.vm.arrangement().left).toEqual(['activity']);
    expect(second.vm.arrangement().sizes.left).toBe(420);
  });

  it('R8.2: one arrangement per mode is shared by every change', async () => {
    const { vm, standIn } = await make(setup());
    standIn.layoutStage.set('finished');
    vm.open('A');
    vm.arrange({ kind: 'place', area: 'findings', to: 'right' });
    const arranged = vm.arrangement();
    vm.open('B');
    expect(vm.mode()).toBe('review');
    expect(vm.arrangement()).toEqual(arranged);
    expect(arranged).not.toEqual(defaultArrangement('review'));
  });

  it('R8.4: resetting Watch leaves Review as it was and drops the watch entry from the file', async () => {
    const transport = setup();
    const { vm } = await make(transport);
    vm.open('A');
    vm.arrange({ kind: 'place', area: 'activity', to: 'left' });
    vm.pickMode('review');
    vm.arrange({ kind: 'place', area: 'findings', to: 'right' });
    const review = vm.arrangement();
    vm.pickMode('watch');
    vm.arrange({ kind: 'reset' });
    await flush();
    expect(vm.arrangement()).toEqual(defaultArrangement('watch'));
    vm.pickMode('review');
    expect(vm.arrangement()).toEqual(review);
    const file = (await transport.loadBuildLayout()) as { modes: Record<string, unknown> };
    expect(file.modes['watch']).toBeUndefined();
    expect(file.modes['review']).toEqual(review);
  });

  describe('R9.1: a remembered arrangement that cannot be used', () => {
    const custom = { ...defaultArrangement('overview'), sizes: { left: 333, right: 520, bottom: 200 } };
    const watch = defaultArrangement('watch');
    const rows: [string, unknown][] = [
      ['cannot be read', 'garbage'],
      ['leaves out an area', { ...watch, tucked: watch.tucked.filter((t) => t.area !== 'findings') }],
      ['names a place the page does not have', { ...watch, tucked: [{ area: 'files', edge: 'top', back: 'right' }, ...watch.tucked.slice(1)] }],
    ];
    it.each(rows)('%s', async (_name, entry) => {
      const transport = setup();
      await transport.saveBuildLayout({ version: 1, modes: { overview: custom, watch: entry } });
      const { vm, standIn } = await make(transport);
      vm.open('A');
      expect(vm.mode()).toBe('watch');
      expect(vm.arrangement()).toEqual(defaultArrangement('watch'));
      expect(standIn.announcement()).toContain(UNREADABLE_WATCH);
      vm.pickMode('overview');
      expect(vm.arrangement()).toEqual(custom);
      vm.pickMode('watch');
      vm.arrange({ kind: 'resize', side: 'left', px: 400 });
      await flush();
      const file = await stored(transport);
      expect(file.watch?.sizes.left).toBe(400);
      expect(file.overview).toEqual(custom);
    });
  });

  it('R9.2: a remembered arrangement too big for the window is drawn smaller and never rewritten', async () => {
    const transport = setup();
    const { vm } = await make(transport);
    vm.open('A');
    vm.arrange({ kind: 'resize', side: 'left', px: 700 });
    await flush();
    const save = vi.spyOn(transport, 'saveBuildLayout');
    vm.room.set({ width: 900, height: 800 });
    expect(vm.drawn().sizes.left).toBe(660);
    expect(vm.arrangement().sizes.left).toBe(700);
    vm.room.set({ width: 1600, height: 800 });
    expect(vm.drawn().sizes.left).toBe(700);
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('R10.2: a stage change ends focus and moves a page the engineer did not switch', async () => {
    const { vm, standIn } = await make(setup());
    vm.open('A');
    vm.focusOn('activity');
    standIn.layoutStage.set('finished');
    await flush();
    expect(vm.focus()).toBeNull();
    expect(vm.mode()).toBe('review');
  });

  it('R10.3: the suggested mark goes when its mode is picked', async () => {
    const { vm, standIn } = await make(setup());
    vm.open('A');
    vm.pickMode('overview');
    standIn.layoutStage.set('finished');
    await flush();
    expect(vm.mode()).toBe('overview');
    expect(vm.suggested()).toBe('review');
    vm.pickMode('review');
    expect(vm.suggested()).toBeNull();
  });

  it('R10.3: the suggested mark goes at the next stage change', async () => {
    const { vm, standIn } = await make(setup());
    vm.open('A');
    vm.pickMode('overview');
    standIn.layoutStage.set('finished');
    await flush();
    expect(vm.suggested()).toBe('review');
    standIn.layoutStage.set('stopped');
    await flush();
    expect(vm.suggested()).toBeNull();
  });

  describe('R10.4: nothing else rearranges the page', () => {
    const events: [string, (s: ReturnType<typeof makeStandIn>) => void][] = [
      ['an agent asks a question or asks to approve an action', (s) => s.waitingNotices.set([{ repo: 'repo' }])],
      ['a task is recorded and the stage does not change', (s) => s.buildRows.set([{ task: 'T1' }])],
      ['a repository stops, or becomes ready and runs, or the review starts, with the stage unchanged', (s) => s.layoutStage.set(s.layoutStage())],
      ['more files change', (s) => s.changedFiles.set(true)],
    ];
    it.each(events)('%s', async (_name, event) => {
      const { vm, standIn } = await make(setup());
      vm.open('A');
      vm.arrange({ kind: 'place', area: 'activity', to: 'left' });
      vm.focusOn('tasks');
      vm.flip('left', 'activity');
      expect(vm.focus()).toBe('tasks');
      expect(vm.arrangement().left).toEqual(['activity']);
      const before = { mode: vm.mode(), arrangement: vm.arrangement(), focus: vm.focus(), flipped: vm.flipped() };
      event(standIn);
      await flush();
      expect({ mode: vm.mode(), arrangement: vm.arrangement(), focus: vm.focus(), flipped: vm.flipped() }).toEqual(before);
    });
  });

  const stages: [LayoutStage, LayoutMode][] = [
    ['started', 'overview'],
    ['running', 'watch'],
    ['stopped', 'overview'],
    ['finished', 'review'],
  ];
  it.each(stages)('R10.5 and R16.1: opening at %s gives %s with its default and leaves the build alone', async (stage, mode) => {
    const { vm, standIn } = await make(setup(), stage);
    vm.pickMode('changes');
    expect(vm.mode()).toBe('changes');
    vm.open('A');
    expect(vm.mode()).toBe(mode);
    expect(vm.arrangement()).toEqual(defaultArrangement(mode));
    expect(standIn.groups()).toEqual([{ key: 'repo' }]);
    expect(standIn.sessions()).toEqual([{ id: 's1' }]);
    expect(standIn.findings()).toEqual([{ title: 'f1' }]);
  });

  it('R12.1: rearranging takes effect at once while the screen is locked', async () => {
    setup();
    const lock = TestBed.inject(LockStore);
    expect(lock.beginBuild('Build')).toBe(true);
    const { vm } = await make(TestBed.inject(KataTransport) as MockTransport);
    vm.open('A');
    vm.pickMode('changes');
    expect(vm.mode()).toBe('changes');
    vm.arrange({ kind: 'resize', side: 'bottom', px: 300 });
    expect(vm.arrangement().sizes.bottom).toBe(300);
    vm.arrange({ kind: 'tuck', area: 'activity' });
    expect(vm.arrangement().tucked.some((t) => t.area === 'activity')).toBe(true);
    vm.focusOn('files');
    expect(vm.focus()).toBe('files');
    vm.arrange({ kind: 'reset' });
    expect(vm.arrangement()).toEqual(defaultArrangement('changes'));
  });

  it('R12.2: the lock still blocks other work after rearranging', async () => {
    const transport = setup();
    const lock = TestBed.inject(LockStore);
    expect(lock.beginBuild('Build')).toBe(true);
    const { vm } = await make(transport);
    vm.open('A');
    vm.pickMode('review');
    vm.arrange({ kind: 'resize', side: 'left', px: 400 });
    expect(vm.arrangement().sizes.left).toBe(400);
    vm.arrange({ kind: 'tuck', area: 'findings' });
    vm.focusOn('files');
    expect(vm.focus()).toBe('files');
    vm.arrange({ kind: 'reset' });
    expect(lock.beginBuild('Other')).toBe(false);
  });

  it('R12.3: rearranging only ever calls saveBuildLayout', async () => {
    const transport = setup();
    const { vm } = await make(transport);
    const calls: string[] = [];
    const methods = transport as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of Object.getOwnPropertyNames(MockTransport.prototype)) {
      if (name === 'constructor' || typeof methods[name] !== 'function') continue;
      const original = methods[name].bind(transport);
      methods[name] = (...args: unknown[]) => {
        calls.push(name);
        return original(...args);
      };
    }
    vm.open('A');
    vm.pickMode('changes');
    vm.arrange({ kind: 'place', area: 'files', to: 'left' });
    vm.arrange({ kind: 'resize', side: 'left', px: 400 });
    vm.arrange({ kind: 'tuck', area: 'activity' });
    vm.focusOn('files');
    vm.unfocus();
    vm.arrange({ kind: 'reset' });
    await flush();
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set(['saveBuildLayout']));
  });

  it('a failed write is a toast and the arrangement stands', async () => {
    const transport = setup();
    const { vm } = await make(transport);
    vm.open('A');
    const toast = vi.spyOn(TestBed.inject(ToastStore), 'error').mockReturnValue(0);
    vi.spyOn(transport, 'saveBuildLayout').mockRejectedValue(new Error('disk full'));
    vm.arrange({ kind: 'resize', side: 'left', px: 400 });
    await flush();
    expect(toast).toHaveBeenCalled();
    expect(vm.arrangement().sizes.left).toBe(400);
  });

  describe('reveal', () => {
    const watchVm = async () => {
      const { vm } = await make(setup());
      vm.open('A');
      return vm;
    };
    const area = (a: AreaId) => a;

    it('does nothing for the area in focus', async () => {
      const vm = await watchVm();
      vm.focusOn(area('activity'));
      vm.reveal('activity');
      expect(vm.focus()).toBe('activity');
    });

    it('ends focus for another area that is on show', async () => {
      const vm = await watchVm();
      vm.focusOn('activity');
      expect(vm.focus()).toBe('activity');
      vm.reveal('tasks');
      expect(vm.focus()).toBeNull();
      expect(vm.flipped()).toEqual({});
    });

    it('brings a tucked area back and saves it', async () => {
      const transport = setup();
      const { vm } = await make(transport);
      vm.open('A');
      vm.reveal('files');
      await flush();
      expect(vm.arrangement().tucked.some((t) => t.area === 'files')).toBe(false);
      expect((await stored(transport)).watch?.right).toEqual(['files']);
    });

    it('flips an area that sits behind another', async () => {
      const vm = await watchVm();
      vm.arrange({ kind: 'place', area: 'files', to: 'left' });
      vm.flip('left', 'tasks');
      vm.reveal('files');
      expect(vm.flipped().left).toBe('files');
    });

    it('R15.1: a rail name shows the area it brings back, even where it joins a stack', async () => {
      const vm = await watchVm();
      vm.arrange({ kind: 'bring-back', area: 'files' });
      vm.arrange({ kind: 'bring-back', area: 'findings' });
      expect(vm.arrangement().right).toEqual(['files', 'findings']);
      expect(vm.flipped().right).toBe('findings');
    });

    it('does nothing for an area already on show', async () => {
      const vm = await watchVm();
      const before = vm.arrangement();
      vm.reveal('tasks');
      expect(vm.flipped()).toEqual({});
      expect(vm.focus()).toBeNull();
      expect(vm.arrangement()).toEqual(before);
    });
  });
});
