import { TestBed } from '@angular/core/testing';
import { KataTransport } from '../../core/transport/kata-transport';
import { MockTransport } from '../../core/transport/mock-transport';
import { MOCK_BUILD_CHANGE, MOCK_MASTER, MOCK_WORKSPACE_FOLDER } from '../../lib/sdlc-mock';
import { ChangesViewModel } from './changes-view.view-model';

const CTX = { folder: MOCK_WORKSPACE_FOLDER, masterRepo: MOCK_MASTER, system: 'claims', change: MOCK_BUILD_CHANGE };

function setup() {
  const transport = new MockTransport();
  TestBed.configureTestingModule({ providers: [ChangesViewModel, { provide: KataTransport, useValue: transport }] });
  return { vm: TestBed.inject(ChangesViewModel), transport };
}

describe('ChangesViewModel', () => {
  it('lists the master first and opens it', async () => {
    const { vm } = setup();
    await vm.open(CTX);
    expect(vm.repos().map((r) => r.repo)).toEqual([MOCK_MASTER, 'claims-core', 'customer-portal']);
    expect(vm.active()?.repo).toBe(MOCK_MASTER);
    expect(vm.part()).toBe('whole');
    expect(vm.gone()).toBe(false);
  });

  it('refreshes only when the turn count grows', async () => {
    const { vm, transport } = setup();
    await vm.open(CTX);
    const files = vi.spyOn(transport, 'sdlcDiffFiles');
    await vm.noteTurns(3);
    expect(files).toHaveBeenCalled();
    files.mockClear();
    await vm.noteTurns(3);
    await vm.noteTurns(2);
    expect(files).not.toHaveBeenCalled();
  });

  it('keeps the selection when the part changes and the file is still listed, and drops it otherwise', async () => {
    const { vm } = setup();
    await vm.open(CTX);
    await vm.select(MOCK_MASTER, 'src/limits.rs');
    await vm.setPart('uncommitted');
    expect(vm.selected()?.path).toBe('src/limits.rs');
    await vm.setPart('committed');
    expect(vm.selected()).toBeNull();
    expect(vm.pair()).toBeNull();
  });
});
