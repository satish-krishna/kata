import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { RunSpec } from '@bindings/RunSpec';
import { LibraryViewModel } from './library.view-model';
import { KataTransport } from '../core/transport/kata-transport';
import { LaunchStore } from '../core/launch/launch.store';
import { toastState } from '@spartan-ng/brain/sonner';
import { history, katasFixture, runDetailFixture } from '../lib/library';

class FakeTransport {
  listRuns = vi.fn(() => Promise.resolve(history));
  loadRun = vi.fn((id: string) => Promise.resolve(runDetailFixture(id)));
  listKatas = vi.fn(() =>
    Promise.resolve({ katas: katasFixture, failures: [] as { path: string; message: string }[] }),
  );
  loadKata = vi.fn((name: string): Promise<RunSpec> => Promise.resolve(katasFixture.find((k) => k.name === name) ?? katasFixture[0]));
  exportBundle = vi.fn(() => Promise.resolve());
  pickDirectory = vi.fn(() => Promise.resolve(null as string | null));
}

function setup(fake = new FakeTransport()) {
  TestBed.configureTestingModule({
    providers: [LibraryViewModel, { provide: KataTransport, useValue: fake }, provideRouter([])],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  return { vm: TestBed.inject(LibraryViewModel), fake, navigate, launches: TestBed.inject(LaunchStore) };
}

const toastText = () =>
  toastState
    .toasts()
    .map((t) => String(t.title))
    .join(' ');

afterEach(() => toastState.reset());

it('loads history and katas on init and selects the newest run', async () => {
  const { vm, fake } = setup();
  await vm.init();
  expect(vm.runs()).toEqual(history);
  expect(vm.kataRows().length).toBe(katasFixture.length);
  expect(vm.selRun()).toBe(history[0].id);
  expect(fake.loadRun).toHaveBeenCalledWith(history[0].id);
  expect(vm.run()?.id).toBe(history[0].id);
  expect(vm.selKata()).toBe(history[0].kata);
});

it('selecting a run loads its detail and ignores an out-of-order response', async () => {
  const { vm, fake } = setup();
  await vm.init();
  let release!: (v: ReturnType<typeof runDetailFixture>) => void;
  fake.loadRun.mockImplementationOnce(() => new Promise((r) => (release = r)));
  const slow = vm.selectRun(history[1].id);
  await vm.selectRun(history[2].id);
  release(runDetailFixture(history[1].id));
  await slow;
  expect(vm.run()?.id).toBe(history[2].id);
});

it('selecting a kata with no runs clears the detail', async () => {
  const fake = new FakeTransport();
  const orphan = { ...structuredClone(katasFixture[0]), name: 'orphan-kata' };
  fake.listKatas.mockResolvedValue({ katas: [...katasFixture, orphan], failures: [] });
  const { vm } = setup(fake);
  await vm.init();
  expect(vm.run()).not.toBeNull();
  await vm.selectKata('orphan-kata');
  expect(vm.selKata()).toBe('orphan-kata');
  expect(vm.run()).toBeNull();
  expect(vm.selRun()).toBeNull();
});

it('shows a kata load failure in the failures list', async () => {
  const fake = new FakeTransport();
  fake.listKatas.mockResolvedValue({ katas: [], failures: [{ path: 'D:/Repos/acme/.kata/bad.toml', message: 'parse error' }] });
  const { vm } = setup(fake);
  await vm.init();
  expect(vm.failures()).toEqual([{ path: 'D:/Repos/acme/.kata/bad.toml', message: 'parse error' }]);
  expect(vm.baseName(vm.failures()[0].path)).toBe('bad.toml');
});

it('Run again opens the task editor, then launches the edited spec with autorun and navigates home', async () => {
  const { vm, navigate, launches } = setup();
  await vm.init();
  await vm.reRun();
  expect(vm.editing()?.name).toBe(history[0].kata);
  vm.confirmReRun('a brand new task');
  const payload = launches.take();
  expect(payload?.autorun).toBe(true);
  expect(payload?.spec.task).toBe('a brand new task');
  expect(vm.editing()).toBeNull();
  expect(navigate).toHaveBeenCalledWith(['/']);
});

it('Open in compose launches the saved spec without autorun', async () => {
  const { vm, navigate, launches } = setup();
  await vm.init();
  await vm.openInCompose();
  expect(launches.take()?.autorun).toBe(false);
  expect(navigate).toHaveBeenCalledWith(['/']);
});

it('a kata load failure on Run again toasts and opens no editor', async () => {
  const { vm, fake } = setup();
  await vm.init();
  fake.loadKata.mockRejectedValueOnce('gone');
  await vm.reRun();
  expect(vm.editing()).toBeNull();
  expect(toastText()).toContain('Failed to load kata: gone');
});

it('export bundle does nothing when no directory is picked, and exports when one is', async () => {
  const { vm, fake } = setup();
  await vm.init();
  await vm.exportBundle();
  expect(fake.exportBundle).not.toHaveBeenCalled();
  fake.pickDirectory.mockResolvedValueOnce('/out');
  await vm.exportBundle();
  expect(fake.exportBundle).toHaveBeenCalledTimes(1);
});

it('cancelling the editor closes it without launching', async () => {
  const { vm, navigate } = setup();
  await vm.init();
  await vm.reRun();
  vm.cancelReRun();
  expect(vm.editing()).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});
