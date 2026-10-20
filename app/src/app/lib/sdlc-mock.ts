/* In-memory AI-SDLC fixtures for the browser demo. Each MockTransport owns one
 * instance, mutated by mock decisions and branch operations, so the demo
 * reflects what the operator did. Deterministic: no clocks, no randomness. */
import type { CatalogEntry } from '@bindings/CatalogEntry';
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

const plugin = (name: string, description: string): CatalogEntry =>
  ({ kind: 'plugin', name, description, source: 'user', path: `~/.claude/plugins/${name}`, provides: [], mcp_servers: [] });

/** Plugins the catalog finds for the demo workspace, so the AI-SDLC screens render in a plain browser. */
export const MOCK_SDLC_CATALOG: CatalogEntry[] = [
  plugin('ai-sdlc', 'intent, spec and plan skills for a change'),
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
  ];
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

  listChanges(): ChangeInfo[] { return this.changes.map((c) => ({ ...c })); }
  branches(): BranchInfo { return { current: this.current, others: [...this.others], default_base: 'main' }; }
  /** Like the backend's `read_doc`: the document is named by its stem; anything else is a caller bug. */
  readDoc(changeName: string, docName: string): string | null {
    if (!DOC_STEMS.has(docName)) throw new Error(`read_doc takes a document stem (intent, spec or plan), not "${docName}"`);
    return this.docs[`${changeName}/${docName}`] ?? null;
  }

  snapshot(): Snapshot { return { head: '0000000000000000000000000000000000000000', dirty: {} }; }
  /** Only a cancelled AI-SDLC run leaves anything behind; discarded paths drop out of the list. */
  leftovers(): Leftovers {
    if (!this.cancelledRun) return { new_commits: [], discardable: [], touched_dirty: [], product_repos_changed: [], product_repos_unchecked: [] };
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
}
