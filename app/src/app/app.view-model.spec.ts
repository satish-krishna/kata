import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { toastState } from '@spartan-ng/brain/sonner';
import type { Versions } from '@bindings/Versions';
import { AppViewModel } from './app.view-model';
import { ToastStore } from './core/toast/toast.store';
import { KataTransport } from './core/transport/kata-transport';
import { MockTransport } from './core/transport/mock-transport';

const found = (version: string): Versions => ({
  workbench: '3.3.0',
  aiSdlc: { kind: 'found', version },
  line: `Workbench 3.3.0 · ai-sdlc ${version}`,
  copy: `Kata Workbench 3.3.0, ai-sdlc ${version}`,
});
const notFound: Versions = {
  workbench: '3.3.0',
  aiSdlc: { kind: 'notFound' },
  line: 'Workbench 3.3.0 · ai-sdlc: not found',
  copy: 'Kata Workbench 3.3.0, ai-sdlc: not found',
};

function setup(transport: MockTransport): AppViewModel {
  TestBed.configureTestingModule({ providers: [AppViewModel, provideRouter([]), { provide: KataTransport, useValue: transport }] });
  return TestBed.inject(AppViewModel);
}

describe('AppViewModel versions', () => {
  beforeEach(() => toastState.reset());
  afterEach(() => toastState.reset());

  it('window focus reads the versions again', async () => {
    const transport = new MockTransport();
    const ask = vi.spyOn(transport, 'appVersions').mockResolvedValueOnce(found('1.3.0')).mockResolvedValueOnce(found('1.4.0'));
    const vm = setup(transport);
    await vi.waitFor(() => expect(vm.versions()?.line).toBe('Workbench 3.3.0 · ai-sdlc 1.3.0'));
    vm.windowFocused();
    await vi.waitFor(() => expect(vm.versions()?.line).toBe('Workbench 3.3.0 · ai-sdlc 1.4.0'));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('window focus after the plugin is removed shows not found', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'appVersions').mockResolvedValueOnce(found('1.3.0')).mockResolvedValueOnce(notFound);
    const vm = setup(transport);
    await vi.waitFor(() => expect(vm.versions()?.line).toContain('ai-sdlc 1.3.0'));
    vm.windowFocused();
    await vi.waitFor(() => expect(vm.versions()?.line).toBe('Workbench 3.3.0 · ai-sdlc: not found'));
  });

  it('copy writes the copy text and says the versions were copied', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'appVersions').mockResolvedValue(found('1.3.0'));
    const write = vi.spyOn(transport, 'copyText').mockResolvedValue(undefined);
    const vm = setup(transport);
    const success = vi.spyOn(TestBed.inject(ToastStore), 'success');
    await vi.waitFor(() => expect(vm.versions()).not.toBeNull());
    await vm.copyVersions();
    expect(write).toHaveBeenCalledWith('Kata Workbench 3.3.0, ai-sdlc 1.3.0');
    expect(success).toHaveBeenCalledWith('Versions copied');
  });

  it('copy with ai-sdlc not found writes the not-found text', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'appVersions').mockResolvedValue(notFound);
    const write = vi.spyOn(transport, 'copyText').mockResolvedValue(undefined);
    const vm = setup(transport);
    await vi.waitFor(() => expect(vm.versions()).not.toBeNull());
    await vm.copyVersions();
    expect(write).toHaveBeenCalledWith('Kata Workbench 3.3.0, ai-sdlc: not found');
  });

  it('copy raises an error toast when the clipboard refuses', async () => {
    const transport = new MockTransport();
    vi.spyOn(transport, 'appVersions').mockResolvedValue(found('1.3.0'));
    vi.spyOn(transport, 'copyText').mockRejectedValue('denied');
    const vm = setup(transport);
    const error = vi.spyOn(TestBed.inject(ToastStore), 'error');
    await vi.waitFor(() => expect(vm.versions()).not.toBeNull());
    await vm.copyVersions();
    expect(error).toHaveBeenCalledWith('Failed to copy the versions: denied');
  });
});
