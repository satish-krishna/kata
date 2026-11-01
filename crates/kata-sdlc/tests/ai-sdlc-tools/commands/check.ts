// check <file>...
// Checks each document, then the documents of one change against each other (a plan's tasks against the spec's
// scenarios, a build log against the plan). It also checks the hook configuration, `.ai-sdlc.json` and
// `intent/<system>/hooks.json`, and a change's record, `change.yml`, before they are committed. Prints one problem per line as `<file>:<line>: <message>`.
// Exit 0 when there are none, 1 when there are, 2 when it could not run.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { UsageError, type Command } from '../common/command.ts';
import { formatProblem, sortProblems } from '../common/problems.ts';
import { CouldNotRun, EXIT, type Problem } from '../common/types.ts';
import { checkChange, type ChangeDoc } from '../changes/cross-check.ts';
import { readDocument } from '../documents/read.ts';
import { parseConfig } from '../events/config.ts';
import { recordProblems } from '../changes/record.ts';
import { parse } from '../vendor/yaml.mjs';
import { findMarker } from '../workspace/marker.ts';

/** The folder of the change a document belongs to: the folder of spec.md and plan.md, or the one above build/. */
function changeFolder(file: string): string {
  const folder = dirname(resolve(file));
  return basename(folder) === 'build' ? dirname(folder) : folder;
}

/** Checks the documents given together against each other, one group per change. */
function changeProblems(docs: ChangeDoc[]): Problem[] {
  const groups = new Map<string, ChangeDoc[]>();
  for (const d of docs) {
    const key = changeFolder(d.file);
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.values()].flatMap((group) => checkChange(group, findMarker((group[0] as ChangeDoc).file)));
}

const isConfig = (file: string): boolean => basename(file) === '.ai-sdlc.json' || basename(file) === 'change.yml' || (basename(file) === 'hooks.json' && basename(dirname(dirname(resolve(file)))) === 'intent');

/** The hook configuration's problems, as the event runner would find them once the file is on the base branch. */
function configProblems(file: string): Problem[] {
  const read = (path: string): string => readFileSync(path, 'utf8');
  if (!existsSync(file)) throw new CouldNotRun(`${file}: cannot read the file: ENOENT`);
  if (basename(file) === 'change.yml') {
    let raw: unknown;
    try {
      raw = parse(read(file));
    } catch (e) {
      return [{ file, line: 1, message: `change.yml is not YAML: ${(e as Error).message.split('\n')[0]}` }];
    }
    return recordProblems(raw).map((message) => ({ file, line: 1, message }));
  }
  if (basename(file) === '.ai-sdlc.json') {
    return parseConfig(read(file), null, '').problems.map((p) => ({ file, line: 1, message: p.replace(/^\.ai-sdlc\.json: /, '') }));
  }
  const system = basename(dirname(resolve(file)));
  const marker = join(dirname(dirname(dirname(resolve(file)))), '.ai-sdlc.json');
  const prefix = `intent/${system}/hooks.json: `;
  return parseConfig(existsSync(marker) ? read(marker) : null, read(file), system)
    .problems.filter((p) => p.startsWith(prefix))
    .map((p) => ({ file, line: 1, message: p.slice(prefix.length) }));
}

/** Every problem `check` finds in the files, sorted; the `commit` command checks the documents it commits with it. */
export function checkFiles(files: string[]): Problem[] {
  const configs = files.filter(isConfig).flatMap(configProblems);
  const docs: ChangeDoc[] = files.filter((f) => !isConfig(f)).map((file) => ({ file, result: readDocument(file) }));
  return sortProblems([...configs, ...docs.flatMap((d) => d.result.problems), ...changeProblems(docs)]);
}

export const check: Command = {
  usage: 'check <file>...',
  run(args) {
    if (args.length === 0) throw new UsageError();
    const problems = checkFiles(args);
    for (const p of problems) process.stdout.write(formatProblem(p) + '\n');
    return problems.length === 0 ? EXIT.PASS : EXIT.PROBLEMS;
  },
};
