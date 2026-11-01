// Hook scripts as committed on the base branch. `intent/hooks/` holds the global layer's scripts and
// `intent/<system>/hooks/` a system's. Before an event runs, both trees are written from the base branch into a
// temporary folder, so the scripts that run are the reviewed ones and never the working files an agent can edit.
// In a hook's `run`, `${hooks}` is its own layer's folder there.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, listFiles } from '../git/git.ts';
import type { Hook } from './config.ts';

export type ScriptFolders = { root: string; folderOf(layer: Hook['layer']): string; remove(): void };

export function exportScripts(master: string, revision: string | null, system: string): ScriptFolders {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-hooks-'));
  const layers = { global: 'intent/hooks', system: `intent/${system}/hooks` };
  if (revision !== null) {
    for (const folder of Object.values(layers)) {
      for (const file of listFiles(master, revision, folder)) {
        const r = git(master, ['cat-file', 'blob', `${revision}:${file.path}`]);
        if (!r.ok) continue;
        const target = join(root, ...file.path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, r.stdout);
        if (file.mode === '100755') chmodSync(target, 0o755);
      }
    }
  }
  return {
    root,
    folderOf: (layer) => join(root, ...layers[layer].split('/')),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
