/* In-memory AI-SDLC fixtures for the browser demo. Each MockTransport owns one
 * instance, mutated by mock decisions and branch operations, so the demo
 * reflects what the operator did. Deterministic: no clocks, no randomness. */
import type { BaseInfo } from '@bindings/BaseInfo';
import type { BuildRow } from '@bindings/BuildRow';
import type { BuildStart } from '@bindings/BuildStart';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { ChangedFile } from '@bindings/ChangedFile';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { ChecksPlan } from '@bindings/ChecksPlan';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { Part } from '@bindings/Part';
import type { Participant } from '@bindings/Participant';
import type { PlanTask } from '@bindings/PlanTask';
import type { PrResult } from '@bindings/PrResult';
import type { PrState } from '@bindings/PrState';
import type { PublishRepo } from '@bindings/PublishRepo';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { RepoState } from '@bindings/RepoState';
import type { RepoStatus } from '@bindings/RepoStatus';
import type { TaskStatus } from '@bindings/TaskStatus';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { ContextState } from '@bindings/ContextState';
import type { DecideOutcome } from '@bindings/DecideOutcome';
import type { Decision } from '@bindings/Decision';
import type { DocState } from '@bindings/DocState';
import type { FinishOutcome } from '@bindings/FinishOutcome';
import type { Leftovers } from '@bindings/Leftovers';
import type { RunLink } from '@bindings/RunLink';
import type { Settings } from '@bindings/Settings';
import type { Snapshot } from '@bindings/Snapshot';
import type { Stage } from '@bindings/Stage';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { DEMO_SETUP_FOLDER, DEMO_WORKSPACE_FOLDER } from './demo';
import type { ScriptStep } from './mock';

export const MOCK_WORKSPACE_FOLDER = DEMO_WORKSPACE_FOLDER;
/** A folder the demo can add that has repos but no committed `.ai-sdlc.json`, so adding it runs setup. */
export const MOCK_SETUP_FOLDER = DEMO_SETUP_FOLDER;
export const MOCK_MASTER = 'claims-intent';
export const MOCK_SYSTEM = 'claims';
export const MOCK_PENDING_BRANCH = 'change/pending-20261018T000000Z';
export const MOCK_NEW_CHANGE = '2026-10-18-new-change';

/** The change the browser demo builds: three tasks across two repositories. */
export const MOCK_BUILD_CHANGE = '2026-10-19-build-demo';
/** The version the demo's `ai-sdlc` plugin reports. */
export const MOCK_PLUGIN_VERSION = '0.6.0';

const plugin = (name: string, description: string, provides: string[] = []): CatalogEntry =>
  ({ kind: 'plugin', name, description, source: 'user', path: `~/.claude/plugins/${name}`, provides, mcp_servers: [] });

/** Plugins the catalog finds for the demo workspace, so the AI-SDLC screens render in a plain browser. */
export const MOCK_SDLC_CATALOG: CatalogEntry[] = [
  plugin('ai-sdlc', 'intent, spec, plan and build skills for a change', ['skill:build', 'skill:intent', 'skill:spec', 'skill:plan', 'skill:context', 'skill:setup']),
  plugin('superpowers', 'planning and review skills'),
];

const TRANSCRIPT_DIR = 'C:/Users/demo/.kata/runs';

/** Scripted `spec` run for `?demo=sdlc`: reads two files, then pauses on one question; the answer finishes it. */
export const sdlcSpecScript: { head: ScriptStep[]; mid: ScriptStep[] } = {
  head: [
    { delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-claims-2026-10-12-fnol-photo-upload-spec-20261018T101500Z.jsonl` } },
    { delay: 350, ev: { type: 'turn', n: 1 } },
    { delay: 250, ev: { type: 'tool.use', name: 'Read', input_summary: 'claims/2026-10-12-fnol-photo-upload/intent.md', id: 'toolu_s1', input: { file_path: 'claims/2026-10-12-fnol-photo-upload/intent.md' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Read', ok: true, summary: 'intent.md - 9 lines', id: 'toolu_s1', output: '# Photo upload at first notice of loss' } },
    { delay: 300, ev: { type: 'tool.use', name: 'Grep', input_summary: 'upload', id: 'toolu_s2', input: { pattern: 'upload', path: 'claims-core/src' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Grep', ok: true, summary: '6 matches', id: 'toolu_s2', output: 'claims-core/src/attachments.rs:12' } },
    { delay: 350, ev: { type: 'ask.requested', id: 'q1', questions: [
      { kind: 'select', header: 'failure', question: 'If an upload fails midway, should the claim still be filed without the photos?',
        options: [ { label: 'Yes, file it', description: 'photos can be added later' }, { label: 'No, block filing', description: 'all or nothing' } ],
        multi_select: false },
    ] } },
  ],
  mid: [
    { delay: 300, ev: { type: 'tool.use', name: 'Write', input_summary: 'claims/2026-10-12-fnol-photo-upload/spec.md', id: 'toolu_s3', input: { file_path: 'claims/2026-10-12-fnol-photo-upload/spec.md' } } },
    { delay: 400, ev: { type: 'tool.result', name: 'Write', ok: true, summary: 'spec.md written', id: 'toolu_s3', output: 'ok' } },
    { delay: 400, ev: { type: 'run.completed', exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.03, duration_ms: 21000, result: 'Spec drafted in spec.md.' } },
  ],
};

/** Scripted `setup` run for `?demo=sdlc-setup`: one question about where the intent artifacts live. */
export const sdlcSetupScript: { head: ScriptStep[]; mid: ScriptStep[] } = {
  head: [
    { delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-setup-20261018T101000Z.jsonl` } },
    { delay: 350, ev: { type: 'turn', n: 1 } },
    { delay: 250, ev: { type: 'tool.use', name: 'Bash', input_summary: 'git -C billing-intent status --short', id: 'toolu_u1', input: { command: 'git -C billing-intent status --short' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Bash', ok: true, summary: 'clean', id: 'toolu_u1', output: '' } },
    { delay: 350, ev: { type: 'ask.requested', id: 'q1', questions: [
      { kind: 'select', header: 'master', question: 'Which repo should hold the intent artifacts?',
        options: [ { label: 'billing-intent', description: 'holds docs only' }, { label: 'billing-core', description: 'also holds product code' } ],
        multi_select: false },
    ] } },
  ],
  mid: [
    { delay: 300, ev: { type: 'tool.use', name: 'Write', input_summary: '.ai-sdlc.json', id: 'toolu_u2', input: { file_path: 'billing-intent/.ai-sdlc.json' } } },
    { delay: 400, ev: { type: 'tool.result', name: 'Write', ok: true, summary: '.ai-sdlc.json written', id: 'toolu_u2', output: 'ok' } },
    { delay: 400, ev: { type: 'run.completed', exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.02, duration_ms: 15000, result: 'Setup committed.' } },
  ],
};

/** What a cancelled demo run leaves behind: a new file, a draft that must not be pre-checked, a file that was already dirty. */
const LEFTOVERS: Leftovers = {
  new_commits: [],
  discardable: ['claims/2026-10-12-fnol-photo-upload/notes.tmp', 'claims/2026-10-12-fnol-photo-upload/intent.md'],
  touched_dirty: ['claims/2026-10-16-fraud-flag/intent.md'],
  created: [],
  product_repos_changed: [],
  product_repos_unchecked: [],
};

const MOCK_SETUP_REPOS = ['billing-intent', 'billing-core'];

const MOCK_REPOS = ['claims-intent', 'claims-core', 'customer-portal', 'billing-api'];

const doc = (status: string | null, committed = true): DocState =>
  status === null ? { exists: false, committed: false, status: null } : { exists: true, committed, status };

const change = (name: string, intent: DocState, spec: DocState, plan: DocState, stage: Stage): ChangeInfo =>
  ({
    system: MOCK_SYSTEM, change: name, intent, spec, plan, stage,
    build: { tasks: 0, finished: 0, repos: 0 }, scope: 'claims', out_of_date: null,
  });

/** The demo build's plan: T3 waits for T1, which lives in the other repository. */
const BUILD_PLAN: PlanTask[] = [
  { id: 'T1', name: 'Refuse an eleventh photo in the attachment store', repo: 'claims-core', dependsOn: [] },
  { id: 'T2', name: 'Add the photo picker to the report form', repo: 'customer-portal', dependsOn: [] },
  { id: 'T3', name: 'Show the upload limit message', repo: 'customer-portal', dependsOn: ['T1'] },
];
/** The field bullets under each demo task's heading, the way a written plan lays them out. */
const TASK_FIELDS: Record<string, string[]> = {
  T1: [
    '**Files:** `attachment-store/limits.rs`, `attachment-store/tests/limits.rs`.',
    '**Change:**\n  - Count the photos already attached to the claim.\n  - Refuse the eleventh with a `PhotoLimit` error.',
    '**Tests:** a claim with ten photos refuses the eleventh (covers R1.1, supports R2.1).',
    '**Done when:** the store refuses the eleventh photo and keeps the first ten.',
  ],
  T2: [
    '**Files:** `src/report/photo-picker.ts`.',
    '**Change:** Add a picker to the report form that lists the chosen photos.',
    '**Tests:** the picker lists what was chosen (covers R1.2).',
    '**Done when:** a policyholder can choose and remove photos on the form.',
  ],
  T3: [
    '**Files:** `src/report/limit-message.ts`, `src/report/report-form.html`.',
    '**Change:**\n  - Read the refusal reason from the store.\n  - Show it next to the picker.',
    '**Tests:** each refusal reason shows its message (covers R2.1, R2.2).',
    '**Done when:** the portal says why a photo was refused.',
  ],
};
/** One demo task's section of the plan: its heading, then Depends on and the field bullets. */
function taskText(t: PlanTask): string {
  const depends = `**Depends on:** ${t.dependsOn.length ? t.dependsOn.join(', ') : 'none'}`;
  return [`### ${t.id}: ${t.name} (\`${t.repo}\`)`, '', ...[depends, ...(TASK_FIELDS[t.id] ?? [])].map((f) => `- ${f}`)].join('\n');
}
const BUILD_REPOS = ['claims-core', 'customer-portal'];
/** The one task whose row records a departure from the plan. */
const DEPARTED_TASK = 'T2';
const DEPARTURE_TEXT = 'Reused the existing file picker instead of building a new one.';

const DOC_STEMS = new Set(['intent', 'spec', 'plan']);

/** Document text keyed by `<change>/<stem>`, the way the backend names them. */
const DOCS: Record<string, string> = {
  '2026-10-16-fraud-flag/intent': '---\nstatus: draft\n---\n# Flag suspected fraud on intake\n\nAdjusters need a visible fraud flag on a claim so that suspicious submissions are reviewed before payout.\n\n## Outcomes\n\n- A claim can be flagged at intake.\n- Flagged claims are routed to the special investigations queue.\n',
  '2026-10-12-fnol-photo-upload/intent': '---\nstatus: accepted\n---\n# Photo upload at first notice of loss\n\nPolicyholders attach damage photos when they report a claim.\n',
  '2026-10-12-fnol-photo-upload/spec': [
    '---\nstatus: draft\n---\n# Spec: photo upload\n',
    '**Context freshness.** The claims-core context was built two commits ago; neither commit touches intake, so the rules below are written against the current behavior of the first notice of loss form and the attachment store it already uses for police reports.\n',
    '## Requirements\n\n1. Up to 10 photos per claim, 10 MB each.\n2. JPEG and PNG only.\n3. Photos are virus-scanned before they are attached.\n',
    '```gherkin\nFeature: Photo upload at first notice of loss\n\n  Rule: R1 - A policyholder attaches up to 10 photos\n\n    Scenario: R1.1 - An eleventh photo is refused\n      Given a claim with 10 photos attached\n      When the policyholder adds "kitchen.jpg"\n      Then the upload is refused # the limit is per claim\n```\n',
    '## Flow\n\n```mermaid\nflowchart LR\n  A[Policyholder] -->|uploads| B(Virus scan)\n  B -->|clean| C[Claim]\n  B -->|infected| D[Rejected]\n```\n',
  ].join('\n'),
  [`${MOCK_BUILD_CHANGE}/intent`]: '---\nstatus: accepted\n---\n# Upload limits at first notice of loss\n\nPolicyholders see why a photo is refused.\n',
  [`${MOCK_BUILD_CHANGE}/spec`]: [
    '---\nstatus: accepted\n---\n# Spec: upload limits\n',
    '## Requirements\n',
    [
      '```gherkin',
      'Feature: Upload limits',
      '',
      '  Rule: R1 — The store refuses an eleventh photo (from: Proposed outcome 1)',
      '',
      '    Scenario: R1.1 — An eleventh photo is refused',
      '      Given a claim with 10 photos attached',
      '      When the policyholder adds another',
      '      Then the upload is refused',
      '',
      '    Scenario: R1.2 — Photos can be removed again',
      '      Given a claim with 3 photos attached',
      '      When the policyholder removes one',
      '      Then 2 photos are attached',
      '',
      '  Rule: R2 — The portal says why (from: Proposed outcome 2, D3)',
      '',
      '    Scenario Outline: R2.1 — Each refusal has a reason',
      '      Given a photo that is <problem>',
      '      Then the portal says "<message>"',
      '',
      '      Examples:',
      '        | problem | message |',
      '        | larger than 10 MB | The photo is over 10 MB |',
      '        | not a JPEG or PNG | Only JPEG and PNG photos are accepted |',
      '',
      '    Scenario: R2.2 — The reason stays until the next attempt',
      '      Given a refused photo',
      '      Then the message stays visible',
      '',
      '  Rule: R3 — The limit shows before the first attempt (from: D5)',
      '',
      '    Scenario: R3.1 — The form states the limit',
      '      Given the report form',
      '      Then it says "Up to 10 photos, 10 MB each"',
      '```',
      '',
    ].join('\n'),
    '## Design\n\nThe attachment store owns the count; the portal renders the reason it returns.\n',
  ].join('\n'),
  [`${MOCK_BUILD_CHANGE}/plan`]: [
    '---\nstatus: accepted\n---\n# Plan: upload limits\n',
    '## Approach\n\nThe store counts and refuses; the portal explains. The two repositories meet at the refusal reason.\n',
    '## Tasks\n',
    ...BUILD_PLAN.map((t) => `${taskText(t)}\n`),
  ].join('\n'),
  '2026-10-09-adjuster-reassign/intent': '---\nstatus: accepted\n---\n# Reassign a claim to another adjuster\n\nSupervisors move a claim between adjusters without losing its history.\n',
  '2026-10-09-adjuster-reassign/spec': '---\nstatus: accepted\n---\n# Spec: reassign\n\n1. Only supervisors can reassign.\n2. Reassignment is recorded in the claim history.\n',
  '2026-10-09-adjuster-reassign/plan': '---\nstatus: draft\n---\n# Plan: reassign\n\n- [ ] Add the reassign endpoint to claims-core.\n- [ ] Add the reassign action to customer-portal.\n',
};

/** What accepting or rejecting does to a change's documents and stage. */
function applyDecision(c: ChangeInfo, decision: Decision): ChangeInfo {
  switch (decision) {
    case 'accept-intent':
      return { ...c, intent: doc('accepted'), stage: 'spec-ready' };
    case 'reject-intent':
      return { ...c, intent: doc('rejected'), stage: 'rejected' };
    case 'accept-spec':
      return { ...c, spec: doc('accepted'), stage: 'plan-ready' };
    case 'accept-plan':
      return { ...c, plan: doc('accepted'), stage: 'build-ready' };
  }
}

export class SdlcMock {
  private settings: Settings = { mode: 'workbench', remember: true, permission_mode: 'bypass' };
  private workspaces: WorkspaceEntry[] = [{
    id: 'acme-claims', name: 'acme-claims', folder: MOCK_WORKSPACE_FOLDER, base_branch: 'main', last_opened: 1792281600,
  }];
  private links: RunLink[] = [];
  private current = 'main';
  /** Other change branches, without the `change/` prefix, like the real `other_change_branches`. */
  private others = ['2026-10-17-claim-notes'];
  private changes: ChangeInfo[] = [
    change('2026-10-16-fraud-flag', doc('draft'), doc(null), doc(null), 'intent-awaiting'),
    change('2026-10-12-fnol-photo-upload', doc('accepted'), doc('draft'), doc(null), 'spec-awaiting'),
    change('2026-10-09-adjuster-reassign', doc('accepted'), doc('accepted'), doc('draft'), 'plan-awaiting'),
    change(MOCK_BUILD_CHANGE, doc('accepted'), doc('accepted'), doc('accepted'), 'build-ready'),
  ];
  /** Rows the scripted build has committed, by task id. */
  private rows = new Map<string, BuildRow>();
  /** Repositories whose pull request the demo has opened. */
  private published = new Set<string>();
  private docs: Record<string, string> = { ...DOCS };
  private setupDone = false;
  private cancelledRun = false;
  private discarded = new Set<string>();

  getSettings(): Settings { return { ...this.settings }; }
  saveSettings(s: Settings): void { this.settings = { ...s }; }
  getWorkspaces(): WorkspaceEntry[] { return this.workspaces.map((w) => ({ ...w })); }
  saveWorkspaces(w: WorkspaceEntry[]): void { this.workspaces = w.map((e) => ({ ...e })); }

  scan(folder: string): WorkspaceScan {
    if (folder === MOCK_SETUP_FOLDER) {
      return {
        folder,
        repos: MOCK_SETUP_REPOS,
        master: { kind: 'one', repo: 'billing-intent', committed: true },
        marker: this.setupDone ? { version: 1, systems: { billing: { repos: MOCK_SETUP_REPOS } } } : null,
        marker_error: null,
      };
    }
    return {
      folder,
      repos: MOCK_REPOS,
      master: { kind: 'one', repo: MOCK_MASTER, committed: true },
      marker: { version: 1, systems: { [MOCK_SYSTEM]: { repos: MOCK_REPOS } } },
      marker_error: null,
    };
  }

  contextHealth(repo: string): ContextState {
    switch (repo) {
      case 'customer-portal': return { kind: 'stale', commits: 14 };
      case 'billing-api': return { kind: 'notCheckedOut' };
      default: return { kind: 'fresh' };
    }
  }

  listChanges(): ChangeInfo[] {
    return this.changes.map((c) => (c.change === MOCK_BUILD_CHANGE
      ? { ...c, build: { tasks: BUILD_PLAN.length, finished: this.rows.size, repos: BUILD_REPOS.length } }
      : { ...c }));
  }
  branches(): BranchInfo { return { current: this.current, others: [...this.others], default_base: 'main' }; }
  /** Like the backend's `read_doc`: the document is named by its stem; anything else is a caller bug. */
  readDoc(changeName: string, docName: string): string | null {
    if (!DOC_STEMS.has(docName)) throw new Error(`read_doc takes a document stem (intent, spec or plan), not "${docName}"`);
    return this.docs[`${changeName}/${docName}`] ?? null;
  }

  snapshot(): Snapshot { return { head: '0000000000000000000000000000000000000000', dirty: {} }; }
  /** Only a cancelled AI-SDLC run leaves anything behind; discarded paths drop out of the list. */
  leftovers(): Leftovers {
    if (!this.cancelledRun) return { new_commits: [], discardable: [], touched_dirty: [], created: [], product_repos_changed: [], product_repos_unchecked: [] };
    const keep = (paths: string[]) => paths.filter((p) => !this.discarded.has(p));
    return { ...LEFTOVERS, discardable: keep(LEFTOVERS.discardable), touched_dirty: keep(LEFTOVERS.touched_dirty) };
  }

  discard(paths: string[]): void { paths.forEach((p) => this.discarded.add(p)); }
  /** A new AI-SDLC run starts clean; cancelling it is what leaves files behind. */
  beginRun(): void { this.cancelledRun = false; this.discarded.clear(); }
  cancelRun(): void { this.cancelledRun = true; }
  finishSetup(): void { this.setupDone = true; }

  startChange(): string {
    this.current = MOCK_PENDING_BRANCH;
    return MOCK_PENDING_BRANCH;
  }

  finishChange(base: string): FinishOutcome {
    this.current = base;
    // A pending branch whose run created no new change folder is deleted.
    if (this.changes.some((c) => c.change === MOCK_NEW_CHANGE)) return 'deleted';
    const branch = `change/${MOCK_NEW_CHANGE}`;
    this.others = [...this.others, MOCK_NEW_CHANGE];
    this.changes = [
      change(MOCK_NEW_CHANGE, doc('draft', false), doc(null), doc(null), 'intent-awaiting'),
      ...this.changes,
    ];
    this.docs[`${MOCK_NEW_CHANGE}/intent`] = '---\nstatus: draft\n---\n# New change\n\nDrafted from the idea you gave the agent.\n';
    return { renamed: { branch, change: MOCK_NEW_CHANGE } };
  }

  checkout(branch: string): void {
    const bare = (b: string) => b.replace(/^change\//, '');
    const leaving = this.current;
    this.others = this.others.filter((b) => b !== bare(branch));
    if (leaving !== branch && leaving.startsWith('change/') && !leaving.startsWith('change/pending-')) this.others.push(bare(leaving));
    this.current = branch;
  }

  decide(changeName: string, decision: Decision): DecideOutcome {
    this.changes = this.changes.map((c) => (c.change === changeName ? applyDecision(c, decision) : c));
    return { kind: 'committed' };
  }

  runLinks(): RunLink[] { return this.links.map((l) => ({ ...l })); }
  linkRun(link: RunLink): void { this.links = [...this.links, { ...link }]; }

  // ---- the build ----

  buildStatus(changeName: string): BuildStatus {
    if (changeName !== MOCK_BUILD_CHANGE) return { tasks: [], repos: [], departures: [], hasTasks: false };
    const tasks: TaskStatus[] = BUILD_PLAN.map((t) => ({ ...t, dependsOn: [...t.dependsOn], text: taskText(t), row: this.rows.get(t.id) ?? null }));
    const departures = tasks.flatMap((t) => (t.row?.departure ? [{ task: t.id, repo: t.repo, planText: t.name, departure: t.row.departure }] : []));
    return { tasks, repos: BUILD_REPOS.map((r) => this.repoStatus(r)), departures, hasTasks: true };
  }

  private repoStatus(repo: string): RepoStatus {
    const mine = BUILD_PLAN.filter((t) => t.repo === repo);
    const first = mine.find((t) => !this.rows.has(t.id));
    const finished = mine.filter((t) => this.rows.has(t.id)).length;
    let state: RepoState = { kind: 'done' };
    if (first) {
      const blocker = first.dependsOn.find((d) => !this.rows.has(d));
      const onRepo = BUILD_PLAN.find((t) => t.id === blocker)?.repo ?? '';
      state = blocker ? { kind: 'waiting', task: first.id, onTask: blocker, onRepo } : { kind: 'ready', task: first.id };
    }
    return { repo, firstUnfinished: first?.id ?? null, state, tasks: mine.length, finished };
  }

  /** The tasks a run in `repo` would do if it started now: the unfinished ones, in order, up to the first that waits. */
  readyTasks(repo: string): PlanTask[] {
    const out: PlanTask[] = [];
    for (const t of BUILD_PLAN.filter((x) => x.repo === repo && !this.rows.has(x.id))) {
      if (t.dependsOn.some((d) => !this.rows.has(d))) break;
      out.push(t);
    }
    return out;
  }

  /** A finished build run commits one row per task it did. */
  commitRows(tasks: PlanTask[]): void {
    for (const t of tasks) {
      this.rows.set(t.id, {
        task: t.id, repo: t.repo, commits: [`${t.id.toLowerCase()}c0ffee`],
        departure: t.id === DEPARTED_TASK ? DEPARTURE_TEXT : null,
      });
    }
  }

  prepare(folder: string, changeName: string): BuildStart {
    const at = (repo: string) => ({ repo, path: `${folder}/${repo}`, base: 'main', branch: `change/${changeName}`, created: false });
    return { master: at(MOCK_MASTER), repos: BUILD_REPOS.map(at) };
  }

  /** The master and the plan's repositories, each checked out beside the master with nothing left uncommitted. */
  participants(folder: string): Participant[] {
    return [MOCK_MASTER, ...BUILD_REPOS].map((repo) => ({ repo, path: `${folder}/${repo}`, master: repo === MOCK_MASTER, files: [], rows: [] }));
  }

  heads(repos: string[]): Record<string, string> {
    return Object.fromEntries(repos.map((r, i) => [r, `${String(i + 1).repeat(7)}`]));
  }

  changeRepos(folder: string, changeName: string): ChangeRepo[] {
    const base = this.diffBase();
    return [MOCK_MASTER, ...BUILD_REPOS].map((repo) => ({ repo, path: `${folder}/${repo}`, branch: `change/${changeName}`, base }));
  }

  diffFiles(part: Part): DiffListing {
    const files = DIFF_FILES.filter((f) => part === 'whole' || (part === 'uncommitted') === f.uncommitted);
    const byType = new Map<string, { extension: string; files: number; added: number; removed: number }>();
    for (const f of files.filter((x) => !x.binary)) {
      const extension = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.') + 1) : '(none)';
      const t = byType.get(extension) ?? { extension, files: 0, added: 0, removed: 0 };
      byType.set(extension, { extension, files: t.files + 1, added: t.added + f.added, removed: t.removed + f.removed });
    }
    return { files: files.map((f) => ({ ...f })), loc: [...byType.values()] };
  }

  diffPair(path: string): FilePair {
    return DIFF_PAIRS[path] ?? { original: '', modified: '', languageHint: 'plaintext', binary: false };
  }

  diffBase(): BaseInfo { return { base: 'main', reference: 'origin/main', mergeBase: '3f9a1c27d0b8e45a6c1f2e9b7d3a508c4e6f1b29' }; }

  touchedRepos(folder: string): PublishRepo[] {
    return [MOCK_MASTER, ...BUILD_REPOS].map((repo) => ({ repo, path: `${folder}/${repo}`, base: 'main' }));
  }

  checksPlan(): ChecksPlan {
    return {
      path: `${MOCK_CHECKS_DIR}/claims.toml`, exists: true,
      checks: [{ repo: 'claims-core', name: 'cargo test', argv: ['cargo', 'test'], timeout_secs: 600 }],
    };
  }

  runChecks(repo: string): RepoChecks {
    if (repo !== 'claims-core') return { repo, results: [], none: true };
    return { repo, none: false, results: [{ name: 'cargo test', argv: ['cargo', 'test'], outcome: { kind: 'Passed' }, tail: 'test result: ok. 14 passed; 0 failed' }] };
  }

  publish(repos: PublishRepo[]): PrResult[] {
    repos.forEach((r) => this.published.add(r.repo));
    return repos.map((r) => ({ repo: r.repo, outcome: { kind: 'opened', url: prUrl(r.repo) } }));
  }

  pullRequests(repos: PublishRepo[]): PrState[] {
    return repos.map((r) => ({ repo: r.repo, url: this.published.has(r.repo) ? prUrl(r.repo) : null }));
  }
}

const MOCK_CHECKS_DIR = 'C:/Users/demo/.kata/checks';
const prUrl = (repo: string) => `https://github.com/acme/${repo}/pull/7`;

/** The canned diff: one file of each kind the Changes view tells apart. */
const DIFF_FILES: ChangedFile[] = [
  { path: 'src/attachments.rs', oldPath: null, status: 'added', binary: false, added: 18, removed: 0, uncommitted: false },
  { path: 'src/limits.rs', oldPath: null, status: 'modified', binary: false, added: 6, removed: 2, uncommitted: true },
  { path: 'src/store.rs', oldPath: 'src/storage.rs', status: 'renamed', binary: false, added: 3, removed: 3, uncommitted: false },
  { path: 'notes/todo.txt', oldPath: null, status: 'untracked', binary: false, added: 4, removed: 0, uncommitted: true },
  { path: 'assets/sample.png', oldPath: null, status: 'added', binary: true, added: 0, removed: 0, uncommitted: false },
];

const ATTACHMENTS = [
  'pub const MAX_PHOTOS: usize = 10;', '', 'pub struct Attachment {', '    pub name: String,', '    pub bytes: Vec<u8>,', '}', '',
  'pub fn accepts(count: usize) -> bool {', '    count < MAX_PHOTOS', '}', '',
].join('\n');
const LIMITS_BEFORE = ['pub fn limit() -> usize {', '    5', '}', '', 'pub fn limit_bytes() -> usize {', '    5 * 1024 * 1024', '}', ''].join('\n');
const LIMITS_AFTER = ['pub fn limit() -> usize {', '    crate::attachments::MAX_PHOTOS', '}', '', 'pub fn limit_bytes() -> usize {', '    10 * 1024 * 1024', '}', ''].join('\n');
const STORE_BEFORE = ['// storage.rs', 'pub fn open() -> Store {', '    Store::default()', '}', ''].join('\n');
const STORE_AFTER = ['// store.rs', 'pub fn open() -> Store {', '    Store::with_limit(limit())', '}', ''].join('\n');

const DIFF_PAIRS: Record<string, FilePair> = {
  'src/attachments.rs': { original: '', modified: ATTACHMENTS, languageHint: 'rust', binary: false },
  'src/limits.rs': { original: LIMITS_BEFORE, modified: LIMITS_AFTER, languageHint: 'rust', binary: false },
  'src/store.rs': { original: STORE_BEFORE, modified: STORE_AFTER, languageHint: 'rust', binary: false },
  'notes/todo.txt': { original: '', modified: 'check the limit with the portal team\nask about HEIC\n', languageHint: 'plaintext', binary: false },
  'assets/sample.png': { original: '', modified: '', languageHint: 'plaintext', binary: true },
};

// ---- scripted build runs ----

const buildTranscript = (repo: string) =>
  ({ delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-claims-${MOCK_BUILD_CHANGE}-build-${repo}-20261019T090000Z.jsonl` } }) as ScriptStep;

/** The steps for one task: read what it needs, then commit it. */
const taskSteps = (t: PlanTask): ScriptStep[] => [
  { delay: 300, ev: { type: 'tool.use', name: 'Edit', input_summary: `${t.repo}: ${t.name}`, id: `toolu_${t.id}e`, input: { file_path: `${t.repo}/src/lib` } } },
  { delay: 300, ev: { type: 'tool.result', name: 'Edit', ok: true, summary: 'edited', id: `toolu_${t.id}e`, output: 'ok' } },
  { delay: 300, ev: { type: 'tool.use', name: 'Bash', input_summary: `git commit -m "feat(sdlc): ${t.name}"`, id: `toolu_${t.id}c`, input: { command: `git commit -m "feat(sdlc): ${t.name}"` } } },
  { delay: 300, ev: { type: 'tool.result', name: 'Bash', ok: true, summary: `committed ${t.id}`, id: `toolu_${t.id}c`, output: '' } },
];

const completed = (result: string): ScriptStep =>
  ({ delay: 350, ev: { type: 'run.completed', exit_code: 0, is_error: false, num_turns: 3, cost_usd: 0.04, duration_ms: 30000, result } });

/** A repository run: it does `tasks` and commits each. With `ask`, it pauses on one question before the first task. */
export function buildRunScript(repo: string, tasks: PlanTask[], ask: boolean): { head: ScriptStep[]; mid: ScriptStep[] } {
  const read: ScriptStep[] = [
    buildTranscript(repo),
    { delay: 300, ev: { type: 'turn', n: 1 } },
    { delay: 300, ev: { type: 'tool.use', name: 'Read', input_summary: `${MOCK_SYSTEM}/${MOCK_BUILD_CHANGE}/plan.md`, id: 'toolu_plan', input: { file_path: `${MOCK_SYSTEM}/${MOCK_BUILD_CHANGE}/plan.md` } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Read', ok: true, summary: 'plan.md', id: 'toolu_plan', output: '### T1' } },
  ];
  const work = [...tasks.flatMap(taskSteps), completed(`${tasks.length} task(s) done in ${repo}.`)];
  if (!ask) return { head: [...read, ...work], mid: [] };
  const question: ScriptStep = { delay: 300, ev: { type: 'ask.requested', id: 'q1', questions: [
    { kind: 'select', header: 'picker', question: 'The report form already has a file picker. Reuse it for photos?',
      options: [ { label: 'Reuse it', description: 'smaller change' }, { label: 'Build a new one', description: 'matches the plan text' } ],
      multi_select: false },
  ] } };
  return { head: [...read, question], mid: work };
}

/** The review run: reads the change and closes with two findings. */
export const reviewRunScript: { head: ScriptStep[]; mid: ScriptStep[] } = {
  head: [
    { delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-claims-${MOCK_BUILD_CHANGE}-review-20261019T093000Z.jsonl` } },
    { delay: 300, ev: { type: 'turn', n: 1 } },
    { delay: 300, ev: { type: 'tool.use', name: 'Bash', input_summary: 'git diff origin/main...HEAD', id: 'toolu_rv1', input: { command: 'git diff origin/main...HEAD' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Bash', ok: true, summary: '5 files changed', id: 'toolu_rv1', output: '' } },
    completed('2 findings. 1. The upload limit is duplicated in claims-core and customer-portal. 2. The refusal message has no test.'),
  ],
  mid: [],
};
