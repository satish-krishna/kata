// One repository's git view of one system: the documents in HEAD, the paths git reports as changed, and object lookups,
// read in a fixed number of git processes however many changes the system has.
import { spawnSync } from 'node:child_process';
import { CouldNotRun } from '../common/types.ts';
import { git, gitMaybe, GIT_OPTIONS, reportedPaths } from './fix-state.ts';

/** Runs `git cat-file <mode>` once with every name on stdin; the raw output as bytes. */
function catFile(top: string, mode: '--batch' | '--batch-check', names: string[]): Buffer {
  const r = spawnSync('git', [...GIT_OPTIONS, 'cat-file', mode], {
    cwd: top,
    input: names.join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    throw new CouldNotRun(`git cat-file failed in ${top}: ${r.stderr?.toString().trim() || r.error?.message}`);
  }
  return r.stdout;
}

/** Parses `cat-file --batch` output: one entry per name, in order; null for a missing or ambiguous name. */
function parseBatch(out: Buffer, count: number): (string | null)[] {
  const texts: (string | null)[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const nl = out.indexOf(0x0a, at);
    if (nl < 0) throw new CouldNotRun('git cat-file --batch ended before every name was answered');
    const header = out.subarray(at, nl).toString('utf8');
    at = nl + 1;
    if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
      texts.push(null);
      continue;
    }
    const size = Number(header.split(' ')[2]);
    // Each object is decoded on its own, by its byte size; the text itself may contain any newline.
    texts.push(out.subarray(at, at + size).toString('utf8'));
    at += size + 1;
  }
  return texts;
}

export class SystemRead {
  readonly top: string;
  readonly system: string;
  readonly hasHead: boolean;
  /** Path under `intent/<system>/` in HEAD -> blob id. */
  readonly headBlobs = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly objects = new Map<string, string | null>();
  private reportedCache: Set<string> | null = null;

  constructor(top: string, system: string) {
    this.top = top;
    this.system = system;
    this.hasHead = gitMaybe(top, ['rev-parse', '--verify', '-q', 'HEAD']) !== null;
    if (this.hasHead) {
      for (const entry of git(top, ['ls-tree', '-r', '-z', 'HEAD', '--', `intent/${system}/`]).split('\0')) {
        const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
        if (m) this.headBlobs.set(m[2] as string, m[1] as string);
      }
    }
  }

  /** The paths under the system folder that git reports as changed in the working tree; run on first use only. */
  get reported(): Set<string> {
    this.reportedCache ??= reportedPaths(this.top, [`intent/${this.system}/`]);
    return this.reportedCache;
  }

  /** Reads every path in HEAD that is not loaded yet in one `cat-file --batch`; starts no process when none is left. */
  loadTexts(paths: string[]): void {
    const todo = [...new Set(paths)].filter((p) => this.headBlobs.has(p) && !this.texts.has(p));
    if (todo.length === 0) return;
    const texts = parseBatch(catFile(this.top, '--batch', todo.map((p) => this.headBlobs.get(p) as string)), todo.length);
    todo.forEach((p, i) => texts[i] !== null && this.texts.set(p, texts[i] as string));
  }

  /** The text of a document in HEAD, exactly as stored; null when HEAD does not have it. */
  headText(path: string): string | null {
    if (!this.headBlobs.has(path)) return null;
    this.loadTexts([path]);
    return this.texts.get(path) ?? null;
  }

  /** Every path in HEAD that starts with `dir`. */
  headPaths(dir: string): string[] {
    return [...this.headBlobs.keys()].filter((p) => p.startsWith(dir));
  }

  /** Answers every `<rev>` and `<rev>:<path>` name not answered yet in one `cat-file --batch-check`. */
  resolve(names: string[]): void {
    const todo: string[] = [];
    for (const n of new Set(names)) {
      if (this.objects.has(n)) continue;
      // A newline would split one name into two lines on stdin.
      if (n.includes('\n')) this.objects.set(n, null);
      else todo.push(n);
    }
    if (todo.length === 0) return;
    const lines = catFile(this.top, '--batch-check', todo).toString('utf8').split('\n');
    todo.forEach((n, i) => {
      const line = lines[i] ?? '';
      this.objects.set(n, line === '' || / (missing|ambiguous)$/.test(line) ? null : (line.split(' ')[0] as string));
    });
  }

  /** The object id a name resolves to; null for a missing or ambiguous name. */
  objectOf(name: string): string | null {
    this.resolve([name]);
    return this.objects.get(name) ?? null;
  }
}
