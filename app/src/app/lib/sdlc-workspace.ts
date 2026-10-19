/* Pure AI-SDLC workspace helpers: where the master repo lives, which repos a workspace has and in what
 * role, and how their context health reads. No Angular, no I/O. */

import type { ContextState } from '@bindings/ContextState';
import type { RunLink } from '@bindings/RunLink';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';

/** A scanned folder the operator is about to add: the dialog shows it, then the VM saves it. */
export type WorkspaceCandidate = {
  folder: string;
  name: string;
  scan: WorkspaceScan;
  contexts: Record<string, ContextState>;
  baseBranch: string;
};

export type RepoRole = 'master' | 'product' | 'not-checked-out';
export type RepoRow = { name: string; role: RepoRole; system: string | null; context: ContextState | null };
export type Tone = 'success' | 'warning' | 'error' | 'idle';

/** `folder` and a repo folder name joined with a forward slash, which every platform's git accepts. */
export function masterPath(folder: string, repo: string): string {
  return `${folder.replace(/[\\/]+$/, '')}/${repo}`;
}

/** The last path segment, used as the default workspace name. */
export function folderName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? folder;
}

export function masterRepo(scan: WorkspaceScan): string | null {
  return scan.master.kind === 'one' ? scan.master.repo : null;
}

/** "Set up" means the marker is committed in the master repo, the same test the plugin's own gate uses. */
export function isSetUp(scan: WorkspaceScan): boolean {
  return scan.master.kind === 'one' && scan.master.committed && scan.marker !== null && scan.marker_error === null;
}

export function systemNames(scan: WorkspaceScan): string[] {
  return Object.keys(scan.marker?.systems ?? {});
}

/** The first system that lists `repo`, or null for a repo no system names. */
export function systemOf(scan: WorkspaceScan, repo: string): string | null {
  for (const [name, def] of Object.entries(scan.marker?.systems ?? {})) {
    if (def?.repos.includes(repo)) return name;
  }
  return null;
}

/** Checked-out folders other than the master: the repos a run should not be writing into. */
export function productRepos(scan: WorkspaceScan): string[] {
  const master = masterRepo(scan);
  return scan.repos.filter((r) => r !== master);
}

/** Every repo the workspace knows: checked out, or named by the marker but absent. The master comes first. */
export function repoRows(scan: WorkspaceScan, contexts: Record<string, ContextState>): RepoRow[] {
  const master = masterRepo(scan);
  const named = Object.values(scan.marker?.systems ?? {}).flatMap((s) => s?.repos ?? []);
  const names = [...new Set([...(master ? [master] : []), ...scan.repos, ...named])];
  return names.map((name) => {
    const role: RepoRole = name === master ? 'master' : scan.repos.includes(name) ? 'product' : 'not-checked-out';
    return { name, role, system: systemOf(scan, name), context: role === 'master' ? null : (contexts[name] ?? null) };
  });
}

export function contextLabel(state: ContextState | null): { text: string; tone: Tone } {
  switch (state?.kind) {
    case 'fresh':
      return { text: 'fresh', tone: 'success' };
    case 'stale':
      return { text: `stale · ${state.commits} ${state.commits === 1 ? 'commit' : 'commits'}`, tone: 'warning' };
    case 'missing':
      return { text: 'missing', tone: 'error' };
    case 'notCheckedOut':
      return { text: 'not checked out', tone: 'idle' };
    default:
      return { text: '—', tone: 'idle' };
  }
}

/** Run context is offered on exactly the rows whose context is missing or behind. */
export function needsContext(state: ContextState | null): boolean {
  return state?.kind === 'missing' || state?.kind === 'stale';
}

/** Latest run start per `<system>/<change>` for one workspace. */
export function lastRunTimes(links: RunLink[], workspaceId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of links) {
    if (l.workspace_id !== workspaceId) continue;
    const key = `${l.system}/${l.change}`;
    out[key] = Math.max(out[key] ?? 0, l.started_at);
  }
  return out;
}

/** `YYYY-MM-DD HH:MM` in UTC, so the same run reads the same on every machine. */
export function formatWhen(epochSecs: number): string {
  return new Date(epochSecs * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
