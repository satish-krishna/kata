// A change's commit scope and the commit rules every commit on its branch follows: the change's scope in the header,
// and the `Generated-By: ai-sdlc` trailer (references/workspace.md, section 8).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Commit } from '../git/git.ts';
import { parseFrontMatter } from '../documents/front-matter.ts';
import { checkScope } from '../workspace/naming.ts';
import { readRecord } from './record.ts';

/** The intent's scope as typed when it is usable, else the scope `change start` recorded, else the system's `commitScope`, else the system name. */
export function changeScope(master: string, system: string, folder: string): string {
  const intent = join(folder, 'intent.md');
  if (existsSync(intent)) {
    const scope = parseFrontMatter(readFileSync(intent, 'utf8'), intent).data.scope;
    if (typeof scope === 'string' && scope !== '' && checkScope(scope).length === 0) return scope;
  }
  const recorded = readRecord(folder)?.scope;
  if (recorded && checkScope(recorded).length === 0) return recorded;
  return systemScope(master, system);
}

/** A system's scope for the commits that are not a change's: its `commitScope` in the marker, else the system name. */
export function systemScope(master: string, system: string): string {
  try {
    const marker = JSON.parse(readFileSync(join(master, '.ai-sdlc.json'), 'utf8')) as { systems?: Record<string, { commitScope?: unknown }> };
    const configured = marker.systems?.[system]?.commitScope;
    if (typeof configured === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(configured)) return configured;
  } catch {
    // An unreadable marker has no commit scope.
  }
  return system;
}

/** Each commit that breaks the commit rules, as `<short sha> <subject>: <why>`. */
export function commitRuleProblems(commits: Commit[], scope: string): string[] {
  return commits.flatMap((c) => {
    const why: string[] = [];
    const header = c.subject.match(/^[a-z]+\(([^)\s]+)\)!?: \S/);
    if (!header || header[1] !== scope) why.push(`its header does not carry the scope ${scope}`);
    if (!c.generatedBy.includes('ai-sdlc')) why.push('it has no Generated-By: ai-sdlc trailer');
    return why.length ? [`${c.sha.slice(0, 7)} ${c.subject}: ${why.join(', and ')}`] : [];
  });
}
