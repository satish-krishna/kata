import { branchLabel, splitPath } from './file-path';

describe('splitPath', () => {
  it('splits a path into its folder and its file name', () => {
    expect(splitPath('app/src/app/core/transport/tauri-transport.ts')).toEqual({ folder: 'app/src/app/core/transport', name: 'tauri-transport.ts' });
    expect(splitPath('src/limits.rs')).toEqual({ folder: 'src', name: 'limits.rs' });
  });

  it('gives a file at the root no folder', () => {
    expect(splitPath('README.md')).toEqual({ folder: '', name: 'README.md' });
  });

  it('keeps a dot folder as it is', () => {
    expect(splitPath('.github/workflows/ci.yml')).toEqual({ folder: '.github/workflows', name: 'ci.yml' });
  });
});

describe('branchLabel', () => {
  it('shortens a change branch and names the base it is compared with', () => {
    expect(branchLabel('change/2026-10-19-ai-sdlc-part-2', 'main')).toEqual({ text: 'change/… → main', title: 'change/2026-10-19-ai-sdlc-part-2 → main' });
  });

  it('leaves out the base until it is known', () => {
    expect(branchLabel('change/2026-10-19-x', null)).toEqual({ text: 'change/…', title: 'change/2026-10-19-x' });
  });

  it('shows a branch that is not a change branch as it is', () => {
    expect(branchLabel('feat/x', 'main')).toEqual({ text: 'feat/x → main', title: 'feat/x → main' });
  });
});
