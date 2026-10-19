/* In-memory AI-SDLC fixtures for the browser demo. Each MockTransport owns one
 * instance, mutated by mock decisions and branch operations, so the demo
 * reflects what the operator did. Deterministic: no clocks, no randomness. */
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

export const MOCK_WORKSPACE_FOLDER = 'D:/Work/acme-claims';
export const MOCK_MASTER = 'claims-intent';
export const MOCK_SYSTEM = 'claims';
export const MOCK_PENDING_BRANCH = 'change/pending-20261018T000000Z';
export const MOCK_NEW_CHANGE = '2026-10-18-new-change';

const MOCK_REPOS = ['claims-intent', 'claims-core', 'customer-portal', 'billing-api'];

const doc = (status: string | null, committed = true): DocState =>
  status === null ? { exists: false, committed: false, status: null } : { exists: true, committed, status };

const change = (name: string, intent: DocState, spec: DocState, plan: DocState, stage: Stage): ChangeInfo =>
  ({ system: MOCK_SYSTEM, change: name, intent, spec, plan, stage });

const DOCS: Record<string, string> = {
  '2026-10-16-fraud-flag/intent.md': '---\nstatus: draft\n---\n# Flag suspected fraud on intake\n\nAdjusters need a visible fraud flag on a claim so that suspicious submissions are reviewed before payout.\n\n## Outcomes\n\n- A claim can be flagged at intake.\n- Flagged claims are routed to the special investigations queue.\n',
  '2026-10-12-fnol-photo-upload/intent.md': '---\nstatus: accepted\n---\n# Photo upload at first notice of loss\n\nPolicyholders attach damage photos when they report a claim.\n',
  '2026-10-12-fnol-photo-upload/spec.md': '---\nstatus: draft\n---\n# Spec: photo upload\n\n## Requirements\n\n1. Up to 10 photos per claim, 10 MB each.\n2. JPEG and PNG only.\n3. Photos are virus-scanned before they are attached.\n',
  '2026-10-09-adjuster-reassign/intent.md': '---\nstatus: accepted\n---\n# Reassign a claim to another adjuster\n\nSupervisors move a claim between adjusters without losing its history.\n',
  '2026-10-09-adjuster-reassign/spec.md': '---\nstatus: accepted\n---\n# Spec: reassign\n\n1. Only supervisors can reassign.\n2. Reassignment is recorded in the claim history.\n',
  '2026-10-09-adjuster-reassign/plan.md': '---\nstatus: draft\n---\n# Plan: reassign\n\n- [ ] Add the reassign endpoint to claims-core.\n- [ ] Add the reassign action to customer-portal.\n',
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
  private settings: Settings = { mode: null, remember: false, permission_mode: 'bypass' };
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
    change('2026-10-09-adjuster-reassign', doc('accepted'), doc('accepted'), doc('draft'), 'plan-written'),
  ];
  private docs: Record<string, string> = { ...DOCS };

  getSettings(): Settings { return { ...this.settings }; }
  saveSettings(s: Settings): void { this.settings = { ...s }; }
  getWorkspaces(): WorkspaceEntry[] { return this.workspaces.map((w) => ({ ...w })); }
  saveWorkspaces(w: WorkspaceEntry[]): void { this.workspaces = w.map((e) => ({ ...e })); }

  scan(folder: string): WorkspaceScan {
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
  readDoc(changeName: string, docName: string): string | null { return this.docs[`${changeName}/${docName}`] ?? null; }

  snapshot(): Snapshot { return { head: '0000000000000000000000000000000000000000', dirty: {} }; }
  leftovers(): Leftovers { return { new_commits: [], discardable: [], touched_dirty: [], product_repos_changed: [] }; }

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
    this.docs[`${MOCK_NEW_CHANGE}/intent.md`] = '---\nstatus: draft\n---\n# New change\n\nDrafted from the idea you gave the agent.\n';
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
