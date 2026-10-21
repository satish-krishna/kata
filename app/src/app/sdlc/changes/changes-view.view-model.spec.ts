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

  it('names each product repository that has no change branch, so its absence from the list is explained', async () => {
    const { vm, transport } = setup();
    expect(await transport.sdlcMissingChangeBranches(CTX.folder, CTX.masterRepo, CTX.system, CTX.change)).toEqual([]);
    vi.spyOn(transport, 'sdlcMissingChangeBranches').mockResolvedValue(['billing']);
    await vm.open(CTX);
    expect(vm.missingBranches()).toEqual(['billing']);
  });

  it('lists the repositories with changes even when the missing branches cannot be read', async () => {
    const { vm, transport } = setup();
    vi.spyOn(transport, 'sdlcMissingChangeBranches').mockRejectedValue(new Error('boom'));
    await vm.open(CTX);
    expect(vm.repos().map((r) => r.repo)).toEqual([MOCK_MASTER, 'claims-core', 'customer-portal']);
    expect(vm.missingBranches()).toEqual([]);
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

  it('says only read-only until the base can be read, then names what the change is compared with', async () => {
    const { vm } = setup();
    expect(vm.readOnlyNote()).toBe('read-only');
    await vm.open(CTX);
    expect(vm.readOnlyNote()).toBe('read-only · compared at the merge base with origin/main');
  });

  it('totals the files and lines of the open part over every repository, counting a binary file as zero lines', async () => {
    const { vm, transport } = setup();
    const listing = await transport.sdlcDiffFiles('x', 'whole');
    vi.spyOn(transport, 'sdlcDiffFiles').mockResolvedValue({
      ...listing,
      files: listing.files.map((f) => (f.binary ? { ...f, added: 9, removed: 9 } : f)),
    });
    await vm.open(CTX);
    expect(vm.fileCount()).toBe(15);
    expect(vm.totals()).toEqual({ added: 93, removed: 15 });
  });

  it('adds the lines by type up over every repository, the biggest type first', async () => {
    const { vm } = setup();
    await vm.open(CTX);
    expect(vm.loc()).toEqual([
      { extension: 'rs', files: 9, added: 81, removed: 15 },
      { extension: 'txt', files: 3, added: 12, removed: 0 },
    ]);
  });

  it('hands the list each repository branch and the base it is compared with', async () => {
    const { vm } = setup();
    await vm.open(CTX);
    expect(vm.groups().map((g) => [g.repo, g.branch, g.base])).toEqual([
      [MOCK_MASTER, `change/${MOCK_BUILD_CHANGE}`, 'main'],
      ['claims-core', `change/${MOCK_BUILD_CHANGE}`, 'main'],
      ['customer-portal', `change/${MOCK_BUILD_CHANGE}`, 'main'],
    ]);
  });
});
