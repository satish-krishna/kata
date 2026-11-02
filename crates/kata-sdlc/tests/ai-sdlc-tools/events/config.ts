// The hook configuration: the hooks in `.ai-sdlc.json` apply to every system, and `intent/<system>/hooks.json` adds a
// system's own. Both are read only as committed on the master repository's base branch, so a hook edited on a change
// branch, or left uncommitted, never runs. A system's hooks are added after the global ones for the same event;
// nothing is replaced or switched off.
import { baseBranch, baseRevision, showFile } from '../git/git.ts';

export const EVENTS = ['change.start', 'doc.accept', 'build.start', 'task.done', 'build.finish', 'review.finish', 'change.done'] as const;
export type EventName = (typeof EVENTS)[number];

/** Events that run once per product repository; the others run in the master repository. */
export const PER_REPOSITORY: readonly EventName[] = ['build.start', 'task.done', 'build.finish'];

/** What a failed blocking hook does when its entry says nothing: send the agent back to fix it, or stop. */
const DEFAULT_ON_FAILURE: Record<EventName, OnFailure> = {
  'change.start': 'stop',
  'doc.accept': 'stop',
  'build.start': 'stop',
  'task.done': 'fix',
  'build.finish': 'fix',
  'review.finish': 'stop',
  'change.done': 'stop',
};

export type OnFailure = 'fix' | 'stop';

export type Hook = {
  id: string;
  event: EventName;
  when: 'before' | 'after';
  run: string[];
  /** The repositories it runs in, `master` for the master repository; null for every one the event runs in. */
  repos: string[] | null;
  timeout: number;
  blocking: boolean;
  onFailure: OnFailure;
  layer: 'global' | 'system';
};

export type HookConfig = {
  /** The revision the configuration was read from, or null when the master has no base branch yet. */
  revision: string | null;
  hooks: Hook[];
  /** How many times the Stop gate sends the agent back to fix one failed hook before it lets the skill stop. */
  gateRetries: number;
  problems: string[];
};

const FIELDS = ['id', 'when', 'run', 'repos', 'timeout', 'blocking', 'onFailure'];
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Reads one layer's `hooks` value. `where` names the file in every problem. */
export function parseHooks(value: unknown, layer: Hook['layer'], where: string): { hooks: Hook[]; problems: string[] } {
  const hooks: Hook[] = [];
  const problems: string[] = [];
  if (value === undefined) return { hooks, problems };
  if (!isObject(value)) return { hooks, problems: [`${where}: hooks must be an object of events`] };
  for (const [event, entries] of Object.entries(value)) {
    if (!(EVENTS as readonly string[]).includes(event)) {
      problems.push(`${where}: ${event} is not an event; the events are ${EVENTS.join(', ')}`);
      continue;
    }
    if (!Array.isArray(entries)) {
      problems.push(`${where}: hooks.${event} must be a list`);
      continue;
    }
    entries.forEach((entry, i) => {
      const at = `${where}: hooks.${event}[${i}]`;
      if (!isObject(entry)) return void problems.push(`${at} must be an object`);
      for (const key of Object.keys(entry)) if (!FIELDS.includes(key)) problems.push(`${at}: unknown field ${key}`);
      const { id, when = 'before', run, repos, timeout = 600, blocking, onFailure } = entry;
      const name = typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : null;
      if (name === null) problems.push(`${at}: id must be letters, digits, dots, hyphens or underscores, starting with a letter or digit`);
      if (when !== 'before' && when !== 'after') problems.push(`${at}: when must be before or after`);
      if (!Array.isArray(run) || run.length === 0 || !run.every((a) => typeof a === 'string' && a !== '')) {
        problems.push(`${at}: run must be a list of the program and its arguments, as non-empty strings`);
      }
      if (repos !== undefined && (!Array.isArray(repos) || !repos.every((r) => typeof r === 'string' && r !== ''))) {
        problems.push(`${at}: repos must be a list of repository names`);
      }
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 86400) {
        problems.push(`${at}: timeout must be a whole number of seconds from 1 to 86400`);
      }
      if (blocking !== undefined && typeof blocking !== 'boolean') problems.push(`${at}: blocking must be true or false`);
      if (blocking === true && when === 'after') problems.push(`${at}: an after hook cannot block; it runs once the event's own step is done`);
      if (onFailure !== undefined && onFailure !== 'fix' && onFailure !== 'stop') problems.push(`${at}: onFailure must be fix or stop`);
      if (name === null || !Array.isArray(run)) return;
      hooks.push({
        id: name,
        event: event as EventName,
        when: when === 'after' ? 'after' : 'before',
        run: run as string[],
        repos: Array.isArray(repos) ? (repos as string[]) : null,
        timeout: typeof timeout === 'number' ? timeout : 600,
        blocking: when === 'after' ? false : blocking !== false,
        onFailure: onFailure === 'fix' || onFailure === 'stop' ? onFailure : DEFAULT_ON_FAILURE[event as EventName],
        layer,
      });
    });
  }
  return { hooks, problems };
}

/** Both layers' hooks merged, global first, with a duplicate id refused: nothing replaces anything. */
export function mergeLayers(global: Hook[], system: Hook[], where: string): { hooks: Hook[]; problems: string[] } {
  const seen = new Set(global.map((h) => h.id));
  const problems: string[] = [];
  for (const h of system) {
    if (seen.has(h.id)) problems.push(`${where}: hook id ${h.id} is already used; hook ids are unique across .ai-sdlc.json and every hooks.json, and a system's hooks only add to the global ones`);
    seen.add(h.id);
  }
  const dupes = global.filter((h, i) => global.findIndex((g) => g.id === h.id) !== i);
  for (const d of dupes) problems.push(`.ai-sdlc.json: hook id ${d.id} is used twice`);
  return { hooks: [...global, ...system], problems };
}

/** Problems with the marker's own hook settings beyond its hooks: `gateRetries`. */
function readGateRetries(marker: Record<string, unknown>, problems: string[]): number {
  const value = marker.gateRetries;
  if (value === undefined) return 3;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 20) {
    problems.push('.ai-sdlc.json: gateRetries must be a whole number from 0 to 20');
    return 3;
  }
  return value;
}

/** Parses both files' text, as committed or as written; either may be null when it does not exist. */
export function parseConfig(markerText: string | null, systemText: string | null, system: string): Omit<HookConfig, 'revision'> {
  const problems: string[] = [];
  let marker: Record<string, unknown> = {};
  if (markerText !== null) {
    try {
      const raw: unknown = JSON.parse(markerText);
      if (isObject(raw)) marker = raw;
      else problems.push('.ai-sdlc.json: the marker is not a JSON object');
    } catch (e) {
      problems.push(`.ai-sdlc.json: the marker is not JSON: ${(e as Error).message}`);
    }
  }
  const systemFile = `intent/${system}/hooks.json`;
  let systemHooks: unknown;
  if (systemText !== null) {
    try {
      const raw: unknown = JSON.parse(systemText);
      if (!isObject(raw)) problems.push(`${systemFile}: not a JSON object`);
      else {
        for (const key of Object.keys(raw)) if (key !== 'version' && key !== 'hooks') problems.push(`${systemFile}: unknown field ${key}`);
        if (raw.version !== 1) problems.push(`${systemFile}: version must be 1`);
        systemHooks = raw.hooks;
      }
    } catch (e) {
      problems.push(`${systemFile}: not JSON: ${(e as Error).message}`);
    }
  }
  const global = parseHooks(marker.hooks, 'global', '.ai-sdlc.json');
  const own = parseHooks(systemHooks, 'system', systemFile);
  const merged = mergeLayers(global.hooks, own.hooks, systemFile);
  const gateRetries = readGateRetries(marker, problems);
  return { hooks: merged.hooks, gateRetries, problems: [...problems, ...global.problems, ...own.problems, ...merged.problems] };
}

/** The configuration as committed on the master repository's base branch. */
export function readHookConfig(master: string, system: string): HookConfig {
  const base = baseBranch(master);
  const revision = base === null ? null : baseRevision(master, base);
  if (revision === null) return { revision: null, hooks: [], gateRetries: 3, problems: [] };
  const parsed = parseConfig(showFile(master, revision, '.ai-sdlc.json'), showFile(master, revision, `intent/${system}/hooks.json`), system);
  return { revision, ...parsed };
}

/** The hooks of one event and side, in the order they run, for one repository. */
export function hooksFor(config: HookConfig, event: EventName, when: Hook['when'], repo: string): Hook[] {
  return config.hooks.filter((h) => h.event === event && h.when === when && (h.repos === null || h.repos.includes(repo)));
}
