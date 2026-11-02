// instructions --json [--write] [--allow-home] [--master <path>] [--workspace <path>]
// The workspace instructions (workspace/instructions.ts): `<master>/intent/workspace.md`, generated from
// `.ai-sdlc.json` and the plugin's template, and its copy between the ai-sdlc markers in `<workspace>/CLAUDE.md`.
// Without --write it checks them; with --write it writes them, never committing. It prints one line:
// `{ "workspaceMd", "claudeMd", "markerLines", "problems" }`.
//   workspaceMd: missing, current or stale (check); written or current (write).
//   claudeMd: current, missing, stale, bad-markers or home-folder (check); created, updated, current, bad-markers or
//   home-folder (write). home-folder: the workspace is the home folder and --allow-home was not given, so CLAUDE.md
//   is left alone (a check does not count it as a problem). bad-markers: the marker lines are not each there once,
//   start first, so CLAUDE.md is left alone.
//   markerLines: the marker lines found in CLAUDE.md, `{ line, text }` with 1-based line numbers.
//   problems: complete sentences to show.
// Exit 0 when everything is current (check) or written (write), 1 when a check found something not current or a
// write left CLAUDE.md alone, 2 when it cannot run (no master repository, or a marker that lists no system).
import { join } from 'node:path';
import { printJson, UsageError, type Command } from '../common/command.ts';
import { parseOptions } from '../common/options.ts';
import { CouldNotRun, EXIT } from '../common/types.ts';
import { instructions as run } from '../workspace/instructions.ts';
import { readMarker } from '../workspace/marker.ts';
import { masterFolderName, resolveWorkspace } from '../workspace/resolve.ts';

export const instructions: Command = {
  usage: 'instructions --json [--write] [--allow-home] [--master <path>] [--workspace <path>]',
  run(args) {
    const o = parseOptions(args, { values: ['master', 'workspace'], flags: ['json', 'write', 'allow-home'] });
    if (!o.flags.has('json') || o.positional.length > 0) throw new UsageError();
    const r = resolveWorkspace(process.cwd(), { ...(o.values.master ? { master: o.values.master } : {}), ...(o.values.workspace ? { workspace: o.values.workspace } : {}) });
    if (r.master === null || r.workspace === null) throw new CouldNotRun(r.problems.join('\n'));
    const out = run({
      workspace: r.workspace,
      master: r.master,
      masterName: masterFolderName(r.workspace, r.master),
      marker: readMarker(join(r.master, '.ai-sdlc.json')),
      write: o.flags.has('write'),
      allowHome: o.flags.has('allow-home'),
    });
    printJson(out);
    return out.problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
