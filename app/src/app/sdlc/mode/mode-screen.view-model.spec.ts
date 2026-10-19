import { TestBed } from '@angular/core/testing';
import { ModeStore } from '../../core/mode/mode.store';
import { ToastStore } from '../../core/toast/toast.store';
import { ModeScreenViewModel } from './mode-screen.view-model';

function setup(choose: () => Promise<void> = () => Promise.resolve()) {
  const store = { choose: vi.fn(choose) };
  const toasts = { error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [ModeScreenViewModel, { provide: ModeStore, useValue: store }, { provide: ToastStore, useValue: toasts }],
  });
  return { vm: TestBed.inject(ModeScreenViewModel), store, toasts };
}

describe('ModeScreenViewModel', () => {
  it('starts on the workbench card with remember on', () => {
    const { vm } = setup();
    expect(vm.selected()).toBe('workbench');
    expect(vm.remember()).toBe(true);
  });

  it('open() chooses sdlc with remember on when the second card is selected', async () => {
    const { vm, store } = setup();
    vm.select('sdlc');
    await vm.open();
    expect(store.choose).toHaveBeenCalledWith('sdlc', true);
  });

  it('open() passes remember off when the box is cleared', async () => {
    const { vm, store } = setup();
    vm.setRemember(false);
    await vm.open();
    expect(store.choose).toHaveBeenCalledWith('workbench', false);
  });

  it('open() reports a failed save instead of throwing', async () => {
    const { vm, toasts } = setup(() => Promise.reject(new Error('disk full')));
    await vm.open();
    expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});
