/* In-memory AI-SDLC fixtures for the browser demo. Each MockTransport owns one
 * instance, mutated by mock decisions and branch operations, so the demo
 * reflects what the operator did. Deterministic: no clocks, no randomness. */
import type { BaseInfo } from '@bindings/BaseInfo';
import type { BuildState } from '@bindings/BuildState';
import type { BuildPhase } from '@bindings/BuildPhase';
import type { StopReport } from '@bindings/StopReport';
import type { WaitingRepo } from '@bindings/WaitingRepo';
import type { StartForm } from '@bindings/StartForm';
import type { BuildRunRef } from '@bindings/BuildRunRef';
import type { RoundOffer } from '@bindings/RoundOffer';
import type { RoundPicks } from '@bindings/RoundPicks';
import type { RoundPlan } from '@bindings/RoundPlan';
import type { RoundRequest } from '@bindings/RoundRequest';
import type { RoundSeverity } from '@bindings/RoundSeverity';
import type { ReviewFinding } from '@bindings/ReviewFinding';
import type { ReviewRow } from '@bindings/ReviewRow';
import type { ReviewRowGroup } from '@bindings/ReviewRowGroup';
import type { ReviewView } from '@bindings/ReviewView';
import type { BuildEvent } from '@bindings/BuildEvent';
import type { ChangeKey } from '@bindings/ChangeKey';
import type { ChangeRef } from '@bindings/ChangeRef';
import type { HeldRepo } from '@bindings/HeldRepo';
import type { StartOutcome } from '@bindings/StartOutcome';
import type { BuildRow } from '@bindings/BuildRow';
import type { CommitFiles } from '@bindings/CommitFiles';
import type { BuildStatus } from '@bindings/BuildStatus';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { ChangedFile } from '@bindings/ChangedFile';
import type { ChangeRepo } from '@bindings/ChangeRepo';
import type { ChecksPlan } from '@bindings/ChecksPlan';
import type { DiffListing } from '@bindings/DiffListing';
import type { FilePair } from '@bindings/FilePair';
import type { ParsedRequirement } from '@bindings/ParsedRequirement';
import type { ParsedSection } from '@bindings/ParsedSection';
import type { ParsedTask } from '@bindings/ParsedTask';
import type { Part } from '@bindings/Part';
import type { PlanTask } from '@bindings/PlanTask';
import type { PrResult } from '@bindings/PrResult';
import type { RenameOutcome } from '@bindings/RenameOutcome';
import type { NamingState } from '../core/transport/kata-transport';
import type { PrState } from '@bindings/PrState';
import type { DoneView } from '@bindings/DoneView';
import type { PublishRepo } from '@bindings/PublishRepo';
import type { ReadResult } from '@bindings/ReadResult';
import type { RepoChecks } from '@bindings/RepoChecks';
import type { RepoState } from '@bindings/RepoState';
import type { RepoStatus } from '@bindings/RepoStatus';
import type { TaskStatus } from '@bindings/TaskStatus';
import type { BranchInfo } from '@bindings/BranchInfo';
import type { ChangeInfo } from '@bindings/ChangeInfo';
import type { ChangeView } from '@bindings/ChangeView';
import type { CopyRemoval } from '@bindings/CopyRemoval';
import type { RemoveOutcome } from '@bindings/RemoveOutcome';
import type { ChangeOffer } from '@bindings/ChangeOffer';
import type { ChangeState } from '@bindings/ChangeState';
import type { FixFacts } from '@bindings/FixFacts';
import type { LiveFacts } from '@bindings/LiveFacts';
import type { StageAction } from '@bindings/StageAction';
import type { StageLabel } from '@bindings/StageLabel';
import type { OfferStage } from '@bindings/OfferStage';
import type { Readiness } from '@bindings/Readiness';
import type { ReadyGate } from '@bindings/ReadyGate';
import type { StateDocument } from '@bindings/StateDocument';
import type { SystemView } from '@bindings/SystemView';
import type { ContextState } from '@bindings/ContextState';
import type { InstructionsState } from '@bindings/InstructionsState';
import type { ReviewRecord } from '@bindings/ReviewRecord';
import type { AcceptOutcome } from '@bindings/AcceptOutcome';
import type { ChangeDocument } from '@bindings/ChangeDocument';
import type { RejectOutcome } from '@bindings/RejectOutcome';
import type { DocState } from '@bindings/DocState';
import type { ChangeStart } from '@bindings/ChangeStart';
import type { Leftovers } from '@bindings/Leftovers';
import type { RunLink } from '@bindings/RunLink';
import type { TaskLink } from '@bindings/TaskLink';
import type { Settings } from '@bindings/Settings';
import type { Snapshot } from '@bindings/Snapshot';
import type { Stage } from '@bindings/Stage';
import type { Track } from '@bindings/Track';
import type { ParsedFinding } from '@bindings/ParsedFinding';
import type { Severity } from '@bindings/Severity';
import type { Concern } from '@bindings/Concern';
import type { WorkspaceEntry } from '@bindings/WorkspaceEntry';
import type { WorkspaceScan } from '@bindings/WorkspaceScan';
import { DEMO_SETUP_FOLDER, DEMO_WORKSPACE_FOLDER } from './demo';
import { PENDING_PERMISSION, type ScriptStep } from './mock';

export const MOCK_WORKSPACE_FOLDER = DEMO_WORKSPACE_FOLDER;
/** A folder the demo can add that has repos but no committed `.ai-sdlc.json`, so adding it runs setup. */
export const MOCK_SETUP_FOLDER = DEMO_SETUP_FOLDER;
export const MOCK_MASTER = 'commerce-docs';
export const MOCK_SYSTEM = 'commerce';
export const MOCK_PENDING_BRANCH = 'change/pending-20261018T000000Z';
export const MOCK_BASE = 'main';
export const MOCK_NEW_CHANGE = '2026-10-18-new-change';

/** The change the browser demo builds: three tasks across two repositories. */
export const MOCK_BUILD_CHANGE = '2026-10-19-build-demo';
/** A second change that builds beside the demo build, in a repository the first does not use. */
export const MOCK_BUILD_SECOND = '2026-10-20-second-build';
/** A change whose build needs a repository the demo build holds, so it starts held. */
export const MOCK_HELD_CHANGE = '2026-10-21-held-build';
/** A change whose build finished and whose three pull requests are open: the toolbar's links and its "Build · done" pill. */
export const MOCK_DONE_CHANGE = '2026-10-18-photo-limits-shipped';
/** The version the demo's `ai-sdlc` plugin reports. */
export const MOCK_PLUGIN_VERSION = '1.1.0';
/** A fix awaiting acceptance: the light track's three documents are drafted. */
export const MOCK_FIX_CHANGE = '2026-10-22-photo-retry-fix';
/** A fix that was rejected, so it is closed. */
export const MOCK_REJECTED_FIX = '2026-10-21-limit-typo-fix';
/** The fix folder the scripted triage of `?demo=start` creates when the engineer takes the light track. */
export const MOCK_STARTED_FIX = '2026-10-24-price-flag-fix';
/** The layouts the mock plugin reads, as the backend's `Readiness::Ready` sends them. */
export const MOCK_LAYOUTS = [1, 2];

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
    { delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-commerce-2026-10-12-product-photo-upload-spec-20261018T101500Z.jsonl` } },
    { delay: 350, ev: { type: 'turn', n: 1 } },
    { delay: 250, ev: { type: 'tool.use', name: 'Read', input_summary: 'commerce/2026-10-12-product-photo-upload/intent.md', id: 'toolu_s1', input: { file_path: 'commerce/2026-10-12-product-photo-upload/intent.md' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Read', ok: true, summary: 'intent.md - 9 lines', id: 'toolu_s1', output: '# Photo upload on the product form' } },
    { delay: 300, ev: { type: 'tool.use', name: 'Grep', input_summary: 'upload', id: 'toolu_s2', input: { pattern: 'upload', path: 'commerce-core/src' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Grep', ok: true, summary: '6 matches', id: 'toolu_s2', output: 'commerce-core/src/attachments.rs:12' } },
    { delay: 350, ev: { type: 'ask.requested', id: 'q1', questions: [
      { kind: 'select', header: 'failure', question: 'If an upload fails midway, should the product still be filed without the photos?',
        options: [ { label: 'Yes, file it', description: 'photos can be added later' }, { label: 'No, block filing', description: 'all or nothing' } ],
        multi_select: false },
    ] } },
  ],
  mid: [
    { delay: 300, ev: { type: 'tool.use', name: 'Write', input_summary: 'commerce/2026-10-12-product-photo-upload/spec.md', id: 'toolu_s3', input: { file_path: 'commerce/2026-10-12-product-photo-upload/spec.md' } } },
    { delay: 400, ev: { type: 'tool.result', name: 'Write', ok: true, summary: 'spec.md written', id: 'toolu_s3', output: 'ok' } },
    { delay: 400, ev: { type: 'run.completed', exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.03, duration_ms: 21000, result: 'Spec drafted in spec.md.' } },
  ],
};

/** The choices the scripted triage asks with when it routes to the light track. */
export const TRIAGE_LIGHT = 'Take the light track';
export const TRIAGE_FULL = 'Take the full pipeline instead';
export const TRIAGE_STOP = 'Stop here';

/**
 * Scripted `triage` run for `?demo=start`: it prints a light-track verdict (the repository, the root cause and about how many tasks), then asks
 * with the three fixed choices. The answer finishes it; only "Take the light track" ends with a fix folder created.
 */
export const sdlcTriageScript: { head: ScriptStep[]; mid: ScriptStep[] } = {
  head: [
    { delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-commerce-new-triage-20261024T090000Z.jsonl` } },
    { delay: 350, ev: { type: 'turn', n: 1 } },
    { delay: 250, ev: { type: 'tool.use', name: 'Grep', input_summary: 'price', id: 'toolu_t1', input: { pattern: 'price', path: 'commerce-core/src' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Grep', ok: true, summary: '3 matches', id: 'toolu_t1', output: 'commerce-core/src/import.rs:41' } },
    { delay: 300, ev: { type: 'assistant.text', text: 'This is a light-track change. It is one repository (`commerce-core`), the import form never sets the flag the price review queue reads, and the fix needs about 2 tasks.' } },
    { delay: 350, ev: { type: 'ask.requested', id: 'q1', questions: [
      { kind: 'select', header: 'route', question: 'How should this change go?',
        options: [ { label: TRIAGE_LIGHT, description: 'one repository, about 2 tasks' }, { label: TRIAGE_FULL, description: 'intent, spec and plan first' }, { label: TRIAGE_STOP, description: 'create nothing' } ],
        multi_select: false },
    ] } },
  ],
  mid: [
    { delay: 300, ev: { type: 'tool.use', name: 'Write', input_summary: 'commerce/2026-10-24-price-flag-fix/intent.md', id: 'toolu_t2', input: { file_path: 'commerce/2026-10-24-price-flag-fix/intent.md' } } },
    { delay: 400, ev: { type: 'tool.result', name: 'Write', ok: true, summary: 'intent.md written', id: 'toolu_t2', output: 'ok' } },
    { delay: 400, ev: { type: 'run.completed', exit_code: 0, is_error: false, num_turns: 2, cost_usd: 0.03, duration_ms: 18000, result: 'Triage done.' } },
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
  discardable: ['commerce/2026-10-12-product-photo-upload/notes.tmp', 'commerce/2026-10-12-product-photo-upload/intent.md'],
  touched_dirty: ['commerce/2026-10-16-price-flag/intent.md'],
  created: [],
  product_repos_changed: [],
  product_repos_unchecked: [],
};

const MOCK_SETUP_REPOS = ['billing-intent', 'billing-core'];

const MOCK_REPOS = ['commerce-docs', 'commerce-core', 'customer-portal', 'billing-api'];

/** The context files of the demo workspace, by repo. billing-api has none. */
const CONTEXTS: Record<string, string> = {
  'commerce-core': [
    '---',
    'repo: commerce-core',
    'system: commerce',
    'source_commit: 4f1c9e2a7b3d5e6f8091a2b3c4d5e6f708192a3b',
    'updated: 2026-10-10',
    '---',
    '# commerce-core',
    '',
    'The commerce service: product import, product lifecycle, and the attachment store.',
    '',
    '## Stack',
    '',
    '- .NET 8 Web API, EF Core over PostgreSQL',
    '- Attachments in blob storage behind `IAttachmentStore`',
    '',
    '## Modules',
    '',
    '| Module | Owns |',
    '| --- | --- |',
    '| `Import` | the product form and its validation |',
    '| `Lifecycle` | product states and the transitions between them |',
    '| `Attachments` | spec sheets and other uploaded files |',
    '',
    '### Import',
    '',
    'A notice is validated in `ProductValidator` before it is saved. Attachments are stored first and linked by id.',
    '',
    '### Lifecycle',
    '',
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> Open',
    '  Open --> Reviewed',
    '  Reviewed --> Published',
    '  Reviewed --> Rejected',
    '```',
    '',
    '## Conventions',
    '',
    '- Commands and queries are separate handlers under `Features/`.',
    '- Every endpoint has an integration test in `tests/Api`.',
    '',
  ].join('\n'),
  'customer-portal': [
    '---',
    'repo: customer-portal',
    'system: commerce',
    'source_commit: 9a8b7c6d5e4f30211203a4b5c6d7e8f901a2b3c4',
    'updated: 2026-09-02',
    '---',
    '# customer-portal',
    '',
    'The Angular portal sellers use to list and follow a product.',
    '',
    '## Stack',
    '',
    '- Angular with standalone components and signals',
    '- Talks to commerce-core over its public REST API',
    '',
    '## Screens',
    '',
    '- **List a product**: the product form, in three steps.',
    '- **My products**: the list and the detail of each product.',
    '',
  ].join('\n'),
};

const doc = (status: string | null, committed = true): DocState =>
  status === null ? { exists: false, committed: false, status: null, head_status: null } : { exists: true, committed, status, head_status: committed ? status : null };

const change = (name: string, intent: DocState, spec: DocState, plan: DocState, stage: Stage, track: Track = 'full'): ChangeInfo =>
  ({
    system: MOCK_SYSTEM, change: name, intent, spec, plan, stage,
    build: { tasks: 0, finished: 0, repos: 0 }, scope: 'commerce', out_of_date: null, plan_unreadable: false, plan_unreadable_reason: null, track, fix_row: stage === 'fix-awaiting' && track === 'fix' ? 6 : null,
  });

/** A fix's three documents, drafted: what the light track writes before the engineer accepts it. */
const fixDocs = (name: string, title: string): Record<string, string> => ({
  [`${name}/intent`]: `---\nstatus: draft\n---\n# ${title}\n\nThe product form shows a retry button after a failed upload.\n`,
  [`${name}/spec`]: `---\nstatus: draft\n---\n# Spec: ${title}\n\n## Requirements\n\n1. A failed upload offers a retry.\n2. A retry keeps the photos already chosen.\n`,
  [`${name}/plan`]: `---\nstatus: draft\n---\n# Plan: ${title}\n\n## Tasks\n\n### T1: Add the retry button to the product form (\`customer-portal\`)\n\n- **Depends on:** none\n`,
});

/** The demo build's plan: T3 waits for T1, which lives in the other repository. */
const BUILD_PLAN: PlanTask[] = [
  { id: 'T1', name: 'Refuse an eleventh photo in the attachment store', repo: 'commerce-core', dependsOn: [] },
  { id: 'T2', name: 'Add the photo picker to the product form', repo: 'customer-portal', dependsOn: [] },
  { id: 'T3', name: 'Show the upload limit message', repo: 'customer-portal', dependsOn: ['T1'] },
];
/**
 * The tasks `?demo=build-long` adds: a third repository and enough tasks in all three to overflow every area of the build page at 1280 by 800
 * (the tasks list, the activity of one repository, the changed files). None waits for another, so the scripted build still ends by itself.
 */
const LONG_PLAN: PlanTask[] = [
  { id: 'T4', name: 'Count photos per product when a product is loaded', repo: 'commerce-core', dependsOn: [] },
  { id: 'T5', name: 'Refuse a photo over ten megabytes', repo: 'commerce-core', dependsOn: [] },
  { id: 'T6', name: 'Refuse a file that is not a JPEG or a PNG', repo: 'commerce-core', dependsOn: [] },
  { id: 'T7', name: 'Keep the first ten photos when the eleventh is refused', repo: 'commerce-core', dependsOn: [] },
  { id: 'T8', name: 'Log every refused photo with its reason', repo: 'commerce-core', dependsOn: [] },
  { id: 'T9', name: 'List the chosen photos with a remove button', repo: 'customer-portal', dependsOn: [] },
  { id: 'T10', name: 'Show the limit before the first attempt', repo: 'customer-portal', dependsOn: [] },
  { id: 'T11', name: 'Keep the refusal message until the next attempt', repo: 'customer-portal', dependsOn: [] },
  { id: 'T12', name: 'Add the photo count to the billing summary', repo: 'billing-api', dependsOn: [] },
  { id: 'T13', name: 'Bill a product for the photos it keeps', repo: 'billing-api', dependsOn: [] },
  { id: 'T14', name: 'Skip refused photos in the billing summary', repo: 'billing-api', dependsOn: [] },
  { id: 'T15', name: 'Round the photo size to the nearest megabyte', repo: 'billing-api', dependsOn: [] },
  { id: 'T16', name: 'Export the photo count with the monthly report', repo: 'billing-api', dependsOn: [] },
  { id: 'T17', name: 'Document the photo fields of the billing summary', repo: 'billing-api', dependsOn: [] },
];
/** The sections of each demo task, the way the format program reads a written plan. */
const TASK_SECTIONS: Record<string, ParsedSection[]> = {
  T1: [
    { title: 'Files', body: '`attachment-store/limits.rs`, `attachment-store/tests/limits.rs`.' },
    { title: 'Change', body: '- Count the photos already attached to the product.\n- Refuse the eleventh with a `PhotoLimit` error.' },
    { title: 'Tests', body: 'a product with ten photos refuses the eleventh (covers R1.1, supports R2.1).' },
    { title: 'Done when', body: 'the store refuses the eleventh photo and keeps the first ten.' },
  ],
  T2: [
    { title: 'Files', body: '`src/report/photo-picker.ts`.' },
    { title: 'Change', body: 'Add a picker to the product form that lists the chosen photos.' },
    { title: 'Tests', body: 'the picker lists what was chosen (covers R1.2).' },
    { title: 'Done when', body: 'a seller can choose and remove photos on the form.' },
  ],
  T3: [
    { title: 'Files', body: '`src/report/limit-message.ts`, `src/report/report-form.html`.' },
    { title: 'Change', body: '- Read the refusal reason from the store.\n- Show it next to the picker.' },
    { title: 'Tests', body: 'each refusal reason shows its message (covers R2.1, R2.2).' },
    { title: 'Done when', body: 'the portal says why a photo was refused.' },
  ],
};
const dependsBody = (t: PlanTask): string => (t.dependsOn.length ? t.dependsOn.join(', ') : 'none');
/** One demo task's section of the plan: its heading, then Depends on and the field bullets. */
function taskText(t: PlanTask): string {
  const field = (title: string, body: string) =>
    body.includes('\n') ? `- **${title}:**\n${body.split('\n').map((l) => `  ${l}`).join('\n')}` : `- **${title}:** ${body}`;
  const sections = TASK_SECTIONS[t.id] ?? [];
  return [`### ${t.id}: ${t.name} (\`${t.repo}\`)`, '', field('Depends on', dependsBody(t)), ...sections.map((x) => field(x.title, x.body))].join('\n');
}
/** The demo plan as the format program reads it (layout 1: the field bullets are the sections). */
const parsedTasks = (plan: PlanTask[]): ParsedTask[] => plan.map((t, i) => ({
  id: t.id,
  name: t.name,
  repo: t.repo,
  depends_on: [...t.dependsOn],
  uses: [],
  files: [],
  covers: [],
  supports: [],
  sections: [{ title: 'Depends on', body: dependsBody(t) }, ...(TASK_SECTIONS[t.id] ?? [])],
  text: taskText(t),
  line: 10 + i * 10,
}));
const BUILD_TASKS: ParsedTask[] = parsedTasks(BUILD_PLAN);
/** The demo spec's requirements as the format program reads them. */
const BUILD_SPEC: ParsedRequirement[] = [
  {
    id: 'R1', title: 'The store refuses an eleventh photo', from: ['Proposed outcome 1'], line: 5,
    scenarios: [
      { id: 'R1.1', title: 'An eleventh photo is refused', outline: false, examples: null, line: 7, steps: ['Given a product with 10 photos attached', 'When the seller adds another', 'Then the upload is refused'] },
      { id: 'R1.2', title: 'Photos can be removed again', outline: false, examples: null, line: 12, steps: ['Given a product with 3 photos attached', 'When the seller removes one', 'Then 2 photos are attached'] },
    ],
  },
  {
    id: 'R2', title: 'The portal says why', from: ['Proposed outcome 2', 'D3'], line: 17,
    scenarios: [
      {
        id: 'R2.1', title: 'Each refusal has a reason', outline: true, line: 19,
        steps: ['Given a photo that is <problem>', 'Then the portal says "<message>"'],
        examples: [['problem', 'message'], ['larger than 10 MB', 'The photo is over 10 MB'], ['not a JPEG or PNG', 'Only JPEG and PNG photos are accepted']],
      },
      { id: 'R2.2', title: 'The reason stays until the next attempt', outline: false, examples: null, line: 28, steps: ['Given a refused photo', 'Then the message stays visible'] },
    ],
  },
  {
    id: 'R3', title: 'The limit shows before the first attempt', from: ['D5'], line: 33,
    scenarios: [
      { id: 'R3.1', title: 'The form states the limit', outline: false, examples: null, line: 35, steps: ['Given the product form', 'Then it says "Up to 10 photos, 10 MB each"'] },
    ],
  },
];
/** The spec's gherkin block, written from the parsed requirements so the demo text and the demo requirements cannot differ. */
function gherkinOf(reqs: ParsedRequirement[]): string {
  const row = (cells: string[]) => `        | ${cells.join(' | ')} |`;
  const lines = ['```gherkin', 'Feature: Upload limits', ''];
  for (const r of reqs) {
    lines.push(`  Rule: ${r.id} — ${r.title} (from: ${r.from.join(', ')})`, '');
    for (const sc of r.scenarios) {
      lines.push(`    ${sc.outline ? 'Scenario Outline' : 'Scenario'}: ${sc.id} — ${sc.title}`, ...sc.steps.map((x) => `      ${x}`), '');
      if (sc.examples) lines.push('      Examples:', ...sc.examples.map(row), '');
    }
  }
  return [...lines, '```', ''].join('\n');
}
const BUILD_REPOS = ['commerce-core', 'customer-portal'];
/** The tasks whose rows record a departure from the plan. */
const DEPARTED_TASKS = ['T2'];
/** The long demo's departures: enough, with its findings, to overflow the findings area. */
const LONG_DEPARTED_TASKS = ['T2', 'T5', 'T8', 'T9', 'T13', 'T14', 'T15', 'T16'];
const DEPARTURE_TEXT = 'Reused the existing file picker instead of building a new one.';

const DOC_STEMS = new Set(['intent', 'spec', 'plan']);

/** Document text keyed by `<change>/<stem>`, the way the backend names them. */
const DOCS: Record<string, string> = {
  '2026-10-16-price-flag/intent': '---\nstatus: draft\n---\n# Flag suspicious prices on import\n\nOwners need a visible price flag on a product so that a suspicious price is reviewed before it is published.\n\n## Outcomes\n\n- A product can be flagged at import.\n- Flagged products are routed to the price review queue.\n',
  '2026-10-12-product-photo-upload/intent': '---\nstatus: accepted\n---\n# Photo upload on the product form\n\nSellers attach product photos when they list a product.\n',
  '2026-10-12-product-photo-upload/spec': [
    '---\nstatus: draft\n---\n# Spec: photo upload\n',
    '**Context freshness.** The commerce-core context was built two commits ago; neither commit touches import, so the rules below are written against the current behavior of the product form and the attachment store it already uses for spec sheets.\n',
    '## Requirements\n\n1. Up to 10 photos per product, 10 MB each.\n2. JPEG and PNG only.\n3. Photos are virus-scanned before they are attached.\n',
    '```gherkin\nFeature: Photo upload on the product form\n\n  Rule: R1 - A seller attaches up to 10 photos\n\n    Scenario: R1.1 - An eleventh photo is refused\n      Given a product with 10 photos attached\n      When the seller adds "kitchen.jpg"\n      Then the upload is refused # the limit is per product\n```\n',
    '## Flow\n\n```mermaid\nflowchart LR\n  A[Seller] -->|uploads| B(Virus scan)\n  B -->|clean| C[Product]\n  B -->|infected| D[Rejected]\n```\n',
  ].join('\n'),
  [`${MOCK_BUILD_CHANGE}/intent`]: '---\nstatus: accepted\n---\n# Upload limits on the product form\n\nSellers see why a photo is refused.\n',
  [`${MOCK_BUILD_CHANGE}/spec`]: [
    '---\nstatus: accepted\n---\n# Spec: upload limits\n',
    '## Requirements\n',
    gherkinOf(BUILD_SPEC),
    '## Design\n\nThe attachment store owns the count; the portal renders the reason it returns.\n',
  ].join('\n'),
  [`${MOCK_BUILD_CHANGE}/plan`]: [
    '---\nstatus: accepted\n---\n# Plan: upload limits\n',
    '## Approach\n\nThe store counts and refuses; the portal explains. The two repositories meet at the refusal reason.\n',
    '## Tasks\n',
    ...BUILD_PLAN.map((t) => `${taskText(t)}\n`),
  ].join('\n'),
  [`${MOCK_DONE_CHANGE}/intent`]: '---\nstatus: accepted\n---\n# Photo limits shipped\n\nSellers see why a photo is refused.\n',
  [`${MOCK_DONE_CHANGE}/spec`]: '---\nstatus: accepted\n---\n# Spec: photo limits\n\n## Design\n\nThe attachment store owns the count.\n',
  [`${MOCK_DONE_CHANGE}/plan`]: '---\nstatus: accepted\n---\n# Plan: photo limits\n\n## Approach\n\nThe store counts and refuses; the portal explains.\n',
  ...fixDocs(MOCK_FIX_CHANGE, 'Retry a failed photo upload'),
  [`${MOCK_REJECTED_FIX}/intent`]: '---\nstatus: rejected\n---\n# Correct the limit message typo\n\nThe limit message misspells "photos".\n',
  '2026-10-09-merchant-reassign/intent': '---\nstatus: accepted\n---\n# Reassign a product to another merchant\n\nSupervisors move a product between merchants without losing its history.\n',
  '2026-10-09-merchant-reassign/spec': '---\nstatus: accepted\n---\n# Spec: reassign\n\n1. Only supervisors can reassign.\n2. Reassignment is recorded in the product history.\n',
  '2026-10-09-merchant-reassign/plan': '---\nstatus: draft\n---\n# Plan: reassign\n\n- [ ] Add the reassign endpoint to commerce-core.\n- [ ] Add the reassign action to customer-portal.\n',
};

/** What accepting a document does to a change's documents and stage. */
function applyAcceptance(c: ChangeInfo, which: ChangeDocument): ChangeInfo {
  switch (which) {
    case 'intent':
      return { ...c, intent: doc('accepted'), stage: 'spec-ready' };
    case 'spec':
      return { ...c, spec: doc('accepted'), stage: 'plan-ready' };
    case 'plan':
      return { ...c, plan: doc('accepted'), stage: 'build-ready' };
  }
}

const GATE: ReadyGate = { candidate: false, stop: null, accept: [] };
const stateDocument = (d: DocState): StateDocument => ({ exists: d.exists, inHead: d.exists && d.committed, headStatus: d.head_status, workingStatus: d.status, uncommitted: d.exists && !d.committed, pin: null });

/** The stage the plugin's answer would carry for a fixture stage; the fixtures still know a stage the plugin does not. */
function offerStage(c: ChangeInfo): OfferStage {
  switch (c.stage) {
    case 'plan-out-of-date': return { 'plan-out-of-date': { cause: c.out_of_date === 'plan-pin' ? 'plan-pin' : 'spec-pin' } };
    case 'fix-needs-plugin': return 'fix-unsettled';
    default: return c.stage;
  }
}

/** The step, words and tone of each stage's label, written out the way the plugin's answer words them. */
const LABEL_DATA: Record<string, StageLabel> = {
  'intent-in-progress': { step: 'intent', text: 'Intent · in progress (not committed)', tone: 'muted' },
  'intent-awaiting': { step: 'intent', text: 'Intent · awaiting acceptance', tone: 'warning' },
  'intent-accepted-uncommitted': { step: 'intent', text: 'Intent · accepted, not committed', tone: 'warning' },
  rejected: { step: 'closed', text: 'Closed · rejected', tone: 'error' },
  'spec-ready': { step: 'spec', text: 'Spec · ready to start', tone: 'muted' },
  'spec-awaiting': { step: 'spec', text: 'Spec · awaiting acceptance', tone: 'warning' },
  'spec-accepted-uncommitted': { step: 'spec', text: 'Spec · accepted, not committed', tone: 'warning' },
  'plan-ready': { step: 'plan', text: 'Plan · ready to start', tone: 'muted' },
  'plan-awaiting': { step: 'plan', text: 'Plan · awaiting acceptance', tone: 'warning' },
  'plan-accepted-uncommitted': { step: 'plan', text: 'Plan · accepted, not committed', tone: 'warning' },
  'plan-out-of-date': { step: 'plan', text: 'Plan · out of date', tone: 'warning' },
  'plan-unreadable': { step: 'plan', text: 'Plan · could not be read', tone: 'warning' },
  'plan-superseded': { step: 'plan', text: 'Plan · superseded', tone: 'warning' },
  'build-ready': { step: 'build', text: 'Build · ready to start', tone: 'muted' },
  'build-stopped': { step: 'build', text: 'Build · in progress (stopped)', tone: 'warning' },
  'build-finished': { step: 'build', text: 'Build · finished, not yet done', tone: 'success' },
  'fix-in-progress': { step: 'intent', text: 'Fix · changes not recorded', tone: 'warning' },
  'fix-unsettled': { step: 'intent', text: 'Fix · statuses not settled', tone: 'warning' },
  'fix-awaiting': { step: 'intent', text: 'Fix · awaiting acceptance', tone: 'warning' },
  'fix-accepting': { step: 'plan', text: 'Fix · acceptance stopped', tone: 'warning' },
};
/** What a full-pipeline change at each stage offers, in order, written out as the plugin's answer lists it. */
const FULL_OFFERS: Record<string, StageAction[]> = {
  'intent-in-progress': ['continue-intent'],
  'intent-awaiting': ['continue-intent', 'accept-intent', 'reject-intent'],
  'intent-accepted-uncommitted': ['commit-acceptance', 'continue-intent'],
  rejected: [],
  'spec-ready': ['start-spec', 'reopen-intent'],
  'spec-awaiting': ['continue-spec', 'accept-spec', 'reopen-intent'],
  'spec-accepted-uncommitted': ['commit-acceptance', 'continue-spec'],
  'plan-ready': ['start-plan', 'reopen-spec', 'reopen-intent'],
  'plan-awaiting': ['accept-plan', 'rerun-plan', 'reopen-intent'],
  'plan-accepted-uncommitted': ['commit-acceptance', 'rerun-plan'],
  // A broken spec pin means the spec is reopened; any other cause means the plan is rewritten.
  'plan-out-of-date': ['rerun-plan'],
  'plan-unreadable': [],
  'plan-superseded': ['rerun-plan'],
  'build-ready': ['start-build', 'reopen-spec', 'reopen-intent'],
  'build-stopped': ['continue-build', 'another-round', 'reopen-spec', 'reopen-intent'],
  'build-finished': ['declare-done', 'another-round', 'run-review', 'reopen-spec', 'reopen-intent'],
};
/** What a change on the light track offers at each stage; a stage not listed offers nothing. */
const FIX_OFFERS: Record<string, StageAction[]> = {
  'fix-in-progress': ['finish-fix-draft'],
  'fix-awaiting': ['accept-fix', 'change-fix', 'reject-fix'],
  'fix-accepting': ['accept-fix', 'change-fix', 'reject-fix'],
  'build-ready': ['start-build', 'reopen-fix'],
  'build-stopped': ['continue-build', 'another-round', 'reopen-fix'],
  'build-finished': ['declare-done', 'another-round', 'run-review', 'reopen-fix'],
  'plan-out-of-date': ['reopen-fix'],
};
/** The actions the plugin's answer marks as regenerating a document that already exists. */
const REVISITING: readonly StageAction[] = ['continue-intent', 'reopen-intent', 'continue-spec', 'reopen-spec', 'rerun-plan', 'finish-fix-draft', 'change-fix', 'reopen-fix'];

/** The change a test or a demo reaches by name only: it is not in the list, and its start of the build is refused with the plugin's message. */
/** The commit of the finished change that names no task. */
export const MOCK_UNTASKED_COMMIT = '5a1ad0c5e7f3b9246d8c0e1a3b5f79d2c4e6a8b0';
export const MOCK_REFUSED_CHANGE = '2026-10-23-refused-build';
/** The plugin's stop for the build skill: the grammar's uncommitted-acceptance message with the file filled in. */
export const MOCK_BUILD_STOP = '`plan.md` has uncommitted changes. Commit the acceptance first, so history shows what was accepted.';

/** What a fixture change offers, as the plugin's answer words it. `refused` holds the plugin's stop text for each action it refuses. */
function offerOf(c: ChangeInfo, refused: Partial<Record<StageAction, string>> = {}): ChangeOffer {
  const stage = offerStage(c);
  const name = typeof stage === 'string' ? stage : 'plan-out-of-date';
  const unreadableFix = c.track === 'fix' && c.fix_row === null && name === 'fix-unsettled';
  const label = unreadableFix ? { ...LABEL_DATA[name], text: 'Fix · could not be read' } : LABEL_DATA[name];
  const specPin = typeof stage !== 'string' && stage['plan-out-of-date'].cause === 'spec-pin';
  const listed = c.track === 'fix' ? (FIX_OFFERS[name] ?? []) : specPin ? (['reopen-spec'] as StageAction[]) : (FULL_OFFERS[name] ?? []);
  // A fix awaiting acceptance may be closed by the full pipeline only at row 6 of the fix-state table.
  const actions: StageAction[] = c.track === 'fix' && name === 'fix-awaiting' && c.fix_row === 6 ? [...listed, 'full-pipeline-instead'] : listed;
  // A fix is reopened without feedback only when its plan is out of date.
  const feedback = (a: StageAction) => a === 'change-fix' || (a === 'reopen-fix' && name !== 'plan-out-of-date');
  return {
    stage,
    label,
    actions: actions.map((action) => ({ action, enabled: refused[action] === undefined, reason: refused[action] ?? null, feedbackRequired: feedback(action), revisits: REVISITING.includes(action) })),
  };
}

const FIX_FACTS: FixFacts = {
  intent: { inHead: true, headStatus: 'draft', workingStatus: 'draft' },
  spec: { inHead: true, headStatus: 'draft', workingStatus: 'draft' },
  plan: { inHead: true, headStatus: 'draft', workingStatus: 'draft' },
  unrecorded: [], ownLinesOnly: false, accepted: 'none', acceptanceLast: false, built: false,
};

/** One fixture change as the backend's `sdlc_change_state` shows it: the plugin's state, what it offers and its live facts. */
export function changeViewOf(
  c: ChangeInfo,
  readiness: Readiness,
  tasks: ChangeState['tasks'] = null,
  refused: Partial<Record<StageAction, string>> = {},
  copy: string | null = null,
): ChangeView {
  const live: LiveFacts = { runLive: false, buildStopped: false, buildLive: false };
  // A fix stands at the row of its own table whatever its plan reads as; only the full pipeline has a stage for an unreadable plan.
  const shown: ChangeInfo = c.plan_unreadable && c.track !== 'fix' ? { ...c, stage: 'plan-unreadable' } : c;
  const stop = refused['start-build'] ?? refused['continue-build'] ?? null;
  return {
    state: {
      change: c.change, master: copy ?? '/m', folder: `${copy ?? '/m'}/intent/${c.system}/${c.change}`, inCopy: copy !== null, title: null, track: c.track,
      documents: { intent: stateDocument(c.intent), spec: stateDocument(c.spec), plan: stateDocument(c.plan) },
      scenarios: null, tasks, buildLogs: {}, review: { committed: 0, draft: 'none' },
      fix: shown.track === 'fix' && shown.fix_row !== null ? { row: shown.fix_row, facts: FIX_FACTS } : null,
      ready: { spec: GATE, plan: GATE, build: stop === null ? GATE : { candidate: false, stop, accept: [] }, review: GATE, done: GATE, reject: GATE },
    },
    offer: offerOf(shown, refused),
    live,
    readiness,
  };
}

export class SdlcMock {
  /** What the demo builds. `?demo=build-long` (browser only) widens it so every area of the build page overflows; unit tests keep the short one. */
  private readonly plan: PlanTask[];
  private readonly repos: string[];
  private readonly planTasks: ParsedTask[];
  private readonly departed: Set<string>;
  private readonly diff: ChangedFile[];
  private readonly pairs: Record<string, FilePair>;
  private readonly reviewFindings: string[];

  /** The long demo's change whose plan the format program cannot read, so the reading rows show a reason. */
  private readonly unreadable: string | null;

  /** `?demo=naming` puts the build demo change on a pending branch that waits for a name; `?demo=clash` and `?demo=clash-push` leave the finished change undeclared with its branch taken on GitHub, found by the readiness check or only by the push. */
  private readonly demo: string | null;

  constructor(long = false, demo: string | null = null) {
    this.demo = demo;
    if (demo === 'naming') this.current = MOCK_PENDING_BRANCH;
    this.unreadable = long ? '2026-10-09-merchant-reassign' : null;
    this.plan = long ? [...BUILD_PLAN, ...LONG_PLAN] : BUILD_PLAN;
    this.repos = long ? [...BUILD_REPOS, 'billing-api'] : BUILD_REPOS;
    this.planTasks = long ? parsedTasks(this.plan) : BUILD_TASKS;
    this.departed = new Set(long ? LONG_DEPARTED_TASKS : DEPARTED_TASKS);
    this.diff = long ? [...DIFF_FILES, ...LONG_DIFF_FILES] : DIFF_FILES;
    this.pairs = long ? LONG_DIFF_PAIRS : DIFF_PAIRS;
    this.reviewFindings = long ? LONG_REVIEW_FINDINGS : REVIEW_FINDINGS;
  }

  private settings: Settings = { mode: 'workbench', remember: true, permission_mode: 'auto' };
  private workspaces: WorkspaceEntry[] = [{
    id: 'acme-commerce', name: 'acme-commerce', folder: MOCK_WORKSPACE_FOLDER, last_opened: 1792281600,
  }];
  private links: RunLink[] = [];
  /** The first demo task is linked to its run; the others are not, so both the known and the unknown session show in the browser. */
  private taskLinksList: TaskLink[] = [{
    workspace_id: 'acme-commerce', system: MOCK_SYSTEM, change: MOCK_BUILD_CHANGE, repo: 'commerce-core', task: 'T1', run_id: 'mock-build-commerce-core',
  }];
  private current = 'main';
  /** Other change branches, without the `change/` prefix, like the real `other_change_branches`. */
  private others = ['2026-10-17-product-notes'];
  private changes: ChangeInfo[] = [
    change('2026-10-16-price-flag', doc('draft'), doc(null), doc(null), 'intent-awaiting'),
    change('2026-10-12-product-photo-upload', doc('accepted'), doc('draft'), doc(null), 'spec-awaiting'),
    change('2026-10-09-merchant-reassign', doc('accepted'), doc('accepted'), doc('draft'), 'plan-awaiting'),
    change(MOCK_BUILD_CHANGE, doc('accepted'), doc('accepted'), doc('accepted'), 'build-ready'),
    change(MOCK_DONE_CHANGE, doc('accepted'), doc('accepted'), doc('accepted'), 'build-finished'),
    change(MOCK_FIX_CHANGE, doc('draft'), doc('draft'), doc('draft'), 'fix-awaiting', 'fix'),
    change(MOCK_REJECTED_FIX, doc('rejected'), doc(null), doc(null), 'rejected', 'fix'),
  ];
  /** Rows the scripted build has committed, by task id. */
  private rows = new Map<string, BuildRow>();
  /** Repositories whose pull request the demo has opened. */
  private published = new Set<string>();
  private docs: Record<string, string> = { ...DOCS };
  private setupDone = false;
  private instructionsWritten = false;
  private cancelledRun = false;
  private discarded = new Set<string>();
  /** Review runs that finished: the scripted plugin records one review in the review document at the end of each. */
  private reviewRuns = 0;

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

  /** Like the backend's `read_context`: the repo's context file, or null when it has none. */
  readContext(repo: string): string | null {
    return CONTEXTS[repo] ?? null;
  }

  listChanges(): ChangeInfo[] {
    return this.changes.map((c) => {
      // Like the backend, a change whose every task is in the build log has finished its build.
      if (c.change === MOCK_BUILD_CHANGE) return { ...c, stage: this.rows.size >= this.plan.length ? 'build-finished' : c.stage, build: { tasks: this.plan.length, finished: this.rows.size, repos: this.repos.length } };
      if (c.change === MOCK_DONE_CHANGE) return { ...c, build: { tasks: this.plan.length, finished: this.plan.length, repos: this.repos.length } };
      return { ...c };
    });
  }
  /** Every change as the plugin reports it. In the long demo one change's plan is unreadable, shown with its reason like the Workbench shows it today. */
  stagePass(): ChangeInfo[] {
    return this.listChanges().map((c) => (c.change === this.unreadable
      ? { ...c, plan_unreadable: true, plan_unreadable_reason: 'the plan has a task with no id' }
      : c));
  }
  /** Like the backend's `sdlc_state`: every change of the system from one answer. In the long demo one change's plan is unreadable, and the answer says why. */
  systemView(system: string, readiness: Readiness): SystemView {
    const blocked = readiness.kind === 'blocked';
    const found = this.stagePass();
    return {
      system,
      readiness,
      canStartChange: !blocked,
      startChangeReason: blocked ? readiness.message : null,
      changes: found.map((c) => changeViewOf(c, readiness, this.tasksOf(c), {}, this.copyOf(c.change))),
      problems: found.flatMap((c) => (c.plan_unreadable && c.plan_unreadable_reason !== null ? [c.plan_unreadable_reason] : [])),
    };
  }
  /** Like the backend's `sdlc_change_state`: one change from the plugin's answer; refuses a change the workspace does not have. */
  changeView(changeName: string, readiness: Readiness): ChangeView {
    if (changeName === MOCK_REFUSED_CHANGE) {
      const refused = change(MOCK_REFUSED_CHANGE, doc('accepted'), doc('accepted'), doc('accepted'), 'build-ready');
      return changeViewOf(refused, readiness, null, { 'start-build': MOCK_BUILD_STOP });
    }
    const found = this.stagePass().find((c) => c.change === changeName);
    if (!found) throw new Error(`no change folder named ${changeName}`);
    return changeViewOf(found, readiness, this.tasksOf(found), {}, this.copyOf(changeName));
  }
  // ---- the change's own copy ----

  /** The finished change still has its own copy, as a change the plugin started does until it is rejected or its copy is removed. */
  private readonly copies = new Set<string>([MOCK_DONE_CHANGE]);

  /** The copy folder of a change that has one, else null. */
  private copyOf(changeName: string): string | null {
    return this.copies.has(changeName) ? `${MOCK_WORKSPACE_FOLDER}/.ai-sdlc/copies/${changeName}` : null;
  }
  /** Removal is offered for the finished change with its pull requests merged; the clash demos leave it undeclared, so nothing is offered. */
  copyRemoval(changeName: string): CopyRemoval {
    return this.copies.has(changeName) && !this.demo?.startsWith('clash') ? { outcome: 'offer' } : { outcome: 'notOffered' };
  }
  copyBranch(changeName: string): string {
    return `change/${changeName}`;
  }
  /** The copy is gone and the branch stays in the master repository. */
  removeCopy(changeName: string): RemoveOutcome {
    this.copies.delete(changeName);
    return { outcome: 'removed', kept: [`change/${changeName}: the branch and its commits stay in the master repository`] };
  }
  openCopyFolder(changeName: string): void {
    if (!this.copies.has(changeName)) throw new Error('this change is not in a copy');
  }

  /** What the plugin reports for the build and the finished change: each repository's tasks, the commits that name each, and the commits that name none. Other changes have no plan to report. */
  private tasksOf(c: ChangeInfo): ChangeState['tasks'] {
    if (c.change !== MOCK_BUILD_CHANGE && c.change !== MOCK_DONE_CHANGE) return null;
    const done = c.change === MOCK_DONE_CHANGE;
    const sha = (id: string) => `${id.toLowerCase()}c0ffee`.padEnd(40, '0');
    const out: NonNullable<ChangeState['tasks']> = {};
    for (const repo of new Set(this.plan.map((t) => t.repo))) {
      const mine = this.plan.filter((t) => t.repo === repo);
      const logged = mine.filter((t) => done || this.rows.has(t.id));
      out[repo] = {
        all: mine.map((t) => t.id),
        logged: logged.map((t) => t.id),
        unlogged: mine.filter((t) => !logged.includes(t)).map((t) => t.id),
        commits: Object.fromEntries(mine.map((t) => [t.id, logged.includes(t) ? [sha(t.id)] : []])),
        untasked: done && repo === 'commerce-core' ? [MOCK_UNTASKED_COMMIT] : [],
        uncommitted: [],
      };
    }
    return out;
  }
  /** A test or a demo changes what the workspace holds for a change: its stage and the facts the stage rests on. */
  patch(changeName: string, patch: Partial<ChangeInfo>): void {
    this.changes = this.changes.map((c) => (c.change === changeName ? { ...c, ...patch } : c));
  }
  branches(): BranchInfo { return { current: this.current, others: this.others.map((change) => ({ branch: `change/${change}`, change, needs_name: false })), default_base: MOCK_BASE, pending_change: this.demo === 'naming' ? `${MOCK_SYSTEM}/${MOCK_BUILD_CHANGE}` : null }; }
  /** Like the backend's `read_doc`: the document is named by its stem; anything else is a caller bug. */
  readDoc(changeName: string, docName: string): string | null {
    if (!DOC_STEMS.has(docName)) throw new Error(`read_doc takes a document stem (intent, spec or plan), not "${docName}"`);
    return this.docs[`${changeName}/${docName}`] ?? null;
  }

  /** Like the backend's `read_parsed`: the spec or plan as the format program reads it; null when the change has no such document. */
  readParsed(changeName: string, docName: string): ReadResult | null {
    if (docName !== 'spec' && docName !== 'plan') throw new Error(`read_parsed takes spec or plan, not "${docName}"`);
    if (this.docs[`${changeName}/${docName}`] === undefined) return null;
    const demo = changeName === MOCK_BUILD_CHANGE || changeName === MOCK_DONE_CHANGE;
    if (docName === 'spec') return { kind: 'spec', layout: 2, document: { requirements: changeName === MOCK_BUILD_CHANGE ? BUILD_SPEC : [] }, problems: [] };
    return { kind: 'plan', layout: 2, document: { tasks: demo ? this.planTasks : [], shared_decisions: [] }, problems: [] };
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
  /** A setup run with `--instructions` refreshes this machine's copy of the workspace instructions; any setup run sets the workspace up. */
  finishSetup(withInstructions = false): void {
    this.setupDone = true;
    if (withInstructions) this.instructionsWritten = true;
  }
  /** Out of date until a setup run with `--instructions` has finished. */
  instructions(): InstructionsState { return this.instructionsWritten ? 'current' : 'out-of-date'; }

  /** The scripted triage ended on the light track: its skill started the fix through the plugin, so the fix folder exists now. */
  createFix(): void {
    if (this.changes.some((c) => c.change === MOCK_STARTED_FIX)) return;
    this.others = [...this.others, MOCK_STARTED_FIX];
    this.changes = [change(MOCK_STARTED_FIX, doc('draft', false), doc('draft', false), doc('draft', false), 'fix-awaiting', 'fix'), ...this.changes];
    Object.assign(this.docs, fixDocs(MOCK_STARTED_FIX, 'Flag suspicious prices on import'));
  }

  /** The name the plugin gives a change described by `title`: the demo date, then the first words. */
  changeName(title: string): string {
    const words = title
      .split(/[\s_/-]+/)
      .map((w) => w.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
      .filter((w) => w !== '')
      .slice(0, 5);
    return `${MOCK_NEW_CHANGE.slice(0, 10)}-${words.length > 0 ? words.join('-') : 'change'}`;
  }

  /** Starting a change the way the plugin does: a taken or invalid branch name is refused and nothing is made; otherwise the change exists, on its own branch, and the master stays where it was. */
  startChange(title: string, branch?: string): ChangeStart {
    const name = this.changeName(title);
    if (branch !== undefined) {
      if (branch === MOCK_BASE || this.others.includes(branch.replace(/^change\//, ''))) {
        return { outcome: 'refused', kind: 'branchTaken', problems: [`${branch} is taken in ${MOCK_MASTER} by the branch ${branch}`] };
      }
      if (/\s/.test(branch)) {
        return { outcome: 'refused', kind: 'branchInvalid', problems: [`${branch}: a branch name cannot contain a space`] };
      }
    }
    const made = branch ?? `change/${name}`;
    this.others = [...this.others, name];
    this.changes = [change(name, doc('draft', false), doc(null), doc(null), 'intent-awaiting'), ...this.changes];
    this.docs[`${name}/intent`] = '---\nstatus: draft\n---\n# New change\n\nDrafted from the idea you gave the agent.\n';
    return { outcome: 'started', change: name, branch: made, copy: `${MOCK_WORKSPACE_FOLDER}/.ai-sdlc/copies/${name}` };
  }

  checkout(branch: string): void {
    const bare = (b: string) => b.replace(/^change\//, '');
    const leaving = this.current;
    this.others = this.others.filter((b) => b !== bare(branch));
    if (leaving !== branch && leaving.startsWith('change/') && !leaving.startsWith('change/pending-')) this.others.push(bare(leaving));
    this.current = branch;
  }

  /** The demo system declares a naming setting; the patterns are the ones the ai-sdlc plugin documents. */
  naming(): NamingState { return { kind: 'setting', branch: '{type}/{scope}-{slug}', pullRequestTitle: '{type}({scope}): {title}' }; }
  /** The plugin renames it everywhere; a change with a pull request recorded under the old name lists it to close by hand. */
  renameBranch(changeName: string, to: string): RenameOutcome {
    const from = `change/${changeName}`;
    const old = changeName === MOCK_DONE_CHANGE && !this.demo?.startsWith('clash') ? [{ repo: MOCK_MASTER, url: `https://github.com/acme/${MOCK_MASTER}/pull/7`, number: 7, source: 'plugin' as const }] : [];
    return { outcome: 'renamed', from, to, repos: ['master', MOCK_MASTER], oldPullRequests: old };
  }

  accept(changeName: string, which: ChangeDocument): AcceptOutcome {
    this.changes = this.changes.map((c) => (c.change === changeName ? applyAcceptance(c, which) : c));
    return { outcome: 'accepted' };
  }

  /** The plugin commits the rejection and removes the change's copy: the change leaves the list, its branch stays. */
  reject(changeName: string): RejectOutcome {
    this.changes = this.changes.filter((c) => c.change !== changeName);
    return { outcome: 'rejected', recordBranch: `change/${changeName}` };
  }

  runLinks(): RunLink[] { return this.links.map((l) => ({ ...l })); }
  linkRun(link: RunLink): void { this.links = [...this.links, { ...link }]; }
  taskLinks(): TaskLink[] { return this.taskLinksList.map((l) => ({ ...l })); }

  // ---- the build ----

  buildStatus(changeName: string): BuildStatus {
    if (changeName !== MOCK_BUILD_CHANGE && changeName !== MOCK_DONE_CHANGE) return { tasks: [], repos: [], departures: [], hasTasks: false, problems: [], logLayouts: [] };
    // The finished change has every task built; the demo build commits its rows one run at a time.
    const rowOf = (t: PlanTask): BuildRow | null =>
      changeName === MOCK_DONE_CHANGE ? { task: t.id, repo: t.repo, commits: [`${t.id.toLowerCase()}c0ffee`], departure: null } : (this.rows.get(t.id) ?? null);
    const tasks: TaskStatus[] = this.plan.map((t) => ({ ...t, dependsOn: [...t.dependsOn], text: taskText(t), row: rowOf(t) }));
    const departures = tasks.flatMap((t) => (t.row?.departure ? [{ task: t.id, repo: t.repo, planText: t.name, departure: t.row.departure }] : []));
    return { tasks, repos: this.repos.map((r) => (changeName === MOCK_DONE_CHANGE ? this.doneRepoStatus(r) : this.repoStatus(r))), departures, hasTasks: true, problems: [], logLayouts: [] };
  }

  /** A repository of the finished change: every task of it is built. */
  private doneRepoStatus(repo: string): RepoStatus {
    const tasks = this.plan.filter((t) => t.repo === repo).length;
    return { repo, firstUnfinished: null, state: { kind: 'done' }, tasks, finished: tasks };
  }

  private repoStatus(repo: string): RepoStatus {
    const mine = this.plan.filter((t) => t.repo === repo);
    const first = mine.find((t) => !this.rows.has(t.id));
    const finished = mine.filter((t) => this.rows.has(t.id)).length;
    let state: RepoState = { kind: 'done' };
    if (first) {
      const blocker = first.dependsOn.find((d) => !this.rows.has(d));
      const onRepo = this.plan.find((t) => t.id === blocker)?.repo ?? '';
      state = blocker ? { kind: 'waiting', task: first.id, onTask: blocker, onRepo } : { kind: 'ready', task: first.id };
    }
    return { repo, firstUnfinished: first?.id ?? null, state, tasks: mine.length, finished };
  }

  /** The tasks a run in `repo` would do if it started now: the unfinished ones, in order, up to the first that waits. */
  readyTasks(repo: string): PlanTask[] {
    const out: PlanTask[] = [];
    for (const t of this.plan.filter((x) => x.repo === repo && !this.rows.has(x.id))) {
      if (t.dependsOn.some((d) => !this.rows.has(d))) break;
      out.push(t);
    }
    return out;
  }

  /** A finished build run commits one row per task it did. */
  /** The scripted review run recorded its review in the review document. */
  recordReview(): void { this.reviewRuns++; }

  /** Like the backend's `review::record`: null until a review run has finished, then one review for each run. */
  reviewRecord(): ReviewRecord | null {
    if (this.reviewRuns === 0) return null;
    const commits = this.heads([MOCK_MASTER, ...this.repos]);
    // Each finding names its repository and what it concerns; a convention finding names the rule it breaks.
    const findings = this.reviewFindings.map((text, i): ParsedFinding => {
      const concern = CONCERNS[i % CONCERNS.length];
      // One finding names no repository, so the round's "Fixed in" choice shows; the others spread over the repositories.
      const repo = i === NO_REPO_FINDING ? {} : { repo: this.repos[i % this.repos.length] };
      return {
        id: `F${i + 1}`, severity: SEVERITIES[i % SEVERITIES.length], file: 'src/upload.ts', line: 10 + i, text,
        ...repo, concern, ...(concern === 'convention' ? { rule: 'tests name the rule they prove' } : {}),
      };
    });
    return {
      layout: 2,
      problems: [],
      master_moved: [],
      reviews: Array.from({ length: this.reviewRuns }, (_, i) => ({ number: i + 1, reviewed_at: '2026-10-19', commits, findings })),
    };
  }

  commitRows(tasks: PlanTask[]): void {
    for (const t of tasks) {
      this.rows.set(t.id, {
        task: t.id, repo: t.repo, commits: [`${t.id.toLowerCase()}c0ffee`],
        departure: this.departed.has(t.id) ? DEPARTURE_TEXT : null,
      });
    }
  }

  heads(repos: string[]): Record<string, string> {
    return Object.fromEntries(repos.map((r, i) => [r, `${String(i + 1).repeat(7)}`]));
  }

  changeRepos(folder: string, changeName: string): ChangeRepo[] {
    const base = this.diffBase();
    return [MOCK_MASTER, ...this.repos].map((repo) => ({ repo, path: `${folder}/${repo}`, branch: `change/${changeName}`, base }));
  }

  diffFiles(part: Part): DiffListing {
    // Once the scripted build has logged every task, its agents have committed what they left.
    // The clash demos declare a finished change done, so its work is all committed too.
    const built = this.rows.size >= this.plan.length || (this.demo?.startsWith('clash') ?? false);
    const files = this.diff.map((f) => (built ? { ...f, uncommitted: false } : f)).filter((f) => part === 'whole' || (part === 'uncommitted') === f.uncommitted);
    const byType = new Map<string, { extension: string; files: number; added: number; removed: number }>();
    for (const f of files.filter((x) => !x.binary)) {
      const extension = f.path.includes('.') ? f.path.slice(f.path.lastIndexOf('.') + 1) : '(none)';
      const t = byType.get(extension) ?? { extension, files: 0, added: 0, removed: 0 };
      byType.set(extension, { extension, files: t.files + 1, added: t.added + f.added, removed: t.removed + f.removed });
    }
    return { files: files.map((f) => ({ ...f })), loc: [...byType.values()] };
  }

  /** One commit per demo task in the repository, with the sha the finished build's row lists (padded to a full hash). */
  commitFiles(repoPath: string): CommitFiles[] {
    const repo = repoPath.slice(repoPath.lastIndexOf('/') + 1);
    return this.plan.filter((t) => t.repo === repo).map((t) => ({
      sha: `${t.id.toLowerCase()}c0ffee`.padEnd(40, '0'),
      files: COMMIT_FILES[t.id] ?? [],
    }));
  }

  diffPair(path: string): FilePair {
    return this.pairs[path] ?? { original: '', modified: '', languageHint: 'plaintext', binary: false };
  }

  diffBase(): BaseInfo { return { base: 'main', reference: 'origin/main', mergeBase: '3f9a1c27d0b8e45a6c1f2e9b7d3a508c4e6f1b29' }; }

  touchedRepos(folder: string): PublishRepo[] {
    return [MOCK_MASTER, ...this.repos].map((repo) => ({ repo, path: `${folder}/${repo}`, base: 'main' }));
  }

  checksPlan(): ChecksPlan {
    return {
      path: `${MOCK_CHECKS_DIR}/commerce.toml`, exists: true,
      checks: [{ repo: 'commerce-core', name: 'cargo test', argv: ['cargo', 'test'], timeout_secs: 600 }],
    };
  }

  runChecks(repo: string): RepoChecks {
    if (repo !== 'commerce-core') return { repo, results: [], none: true };
    return { repo, none: false, results: [{ name: 'cargo test', argv: ['cargo', 'test'], outcome: { kind: 'Passed' }, tail: 'test result: ok. 14 passed; 0 failed' }] };
  }

  /** Only `?demo=clash-push` finds the branch taken at the push: the first repository refuses it, the others open their pull request. */
  publish(repos: PublishRepo[], changeName: string): PrResult[] {
    const taken = this.demo === 'clash-push' ? repos[0]?.repo : undefined;
    repos.filter((r) => r.repo !== taken).forEach((r) => this.published.add(r.repo));
    return repos.map((r): PrResult => (r.repo === taken
      ? { repo: r.repo, outcome: { kind: 'clash', branch: `change/${changeName}` } }
      : { repo: r.repo, outcome: { kind: 'opened', url: prUrl(r.repo) } }));
  }

  /** The done view as the Workbench shows it with nothing saved: done while every touched repository has an open pull request. */
  doneView(repos: PublishRepo[], changeName: string, buildFinished: boolean): DoneView {
    const prs = this.pullRequests(repos, changeName);
    const links = prs.flatMap((p) => (p.url === null ? [] : [{ repo: p.repo, url: p.url, state: 'open' as const, seenAt: null }]));
    const done = buildFinished && prs.length > 0 && links.length === prs.length;
    // Like a saved record: the links a partial publish opened stay, labeled as opened.
    const linksFrom = links.length === 0 ? 'none' as const : done ? 'github' as const : 'opened' as const;
    return { done, links, linksFrom, offerDeclare: buildFinished && !done, prCheckFailed: false };
  }

  pullRequests(repos: PublishRepo[], changeName: string): PrState[] {
    // The clash demos leave the finished change without pull requests, so Declare done is offered.
    const open = (repo: string) => (changeName === MOCK_DONE_CHANGE && !this.demo?.startsWith('clash')) || this.published.has(repo);
    return repos.map((r) => ({ repo: r.repo, url: open(r.repo) ? prUrl(r.repo) : null }));
  }
}

const MOCK_CHECKS_DIR = 'C:/Users/demo/.kata/checks';
const prUrl = (repo: string) => `https://github.com/acme/${repo}/pull/7`;

/** The files each demo task's commit touched. */
const COMMIT_FILES: Record<string, string[]> = {
  T1: ['src/attachments.rs'],
  T2: ['assets/sample.png'],
  T3: ['src/store.rs'],
};

/** The canned diff: one file of each kind the Changes view tells apart. */
const DIFF_FILES: ChangedFile[] = [
  { path: 'src/attachments.rs', oldPath: null, status: 'added', binary: false, added: 18, removed: 0, uncommitted: false },
  { path: 'src/limits.rs', oldPath: null, status: 'modified', binary: false, added: 6, removed: 2, uncommitted: true },
  { path: 'src/store.rs', oldPath: 'src/storage.rs', status: 'renamed', binary: false, added: 3, removed: 3, uncommitted: false },
  { path: 'notes/todo.txt', oldPath: null, status: 'untracked', binary: false, added: 4, removed: 0, uncommitted: true },
  { path: 'assets/sample.png', oldPath: null, status: 'added', binary: true, added: 0, removed: 0, uncommitted: false },
];

/** The fields of the long file in the long demo's diff: more lines than the diff editor shows at once at 1280 by 800. */
const SCHEMA_FIELDS = 120;
/** What the long demo adds to the canned diff: one long file and a run of small ones, so the list of changed files overflows too. */
const LONG_DIFF_FILES: ChangedFile[] = [
  { path: 'src/schema.rs', oldPath: null, status: 'added', binary: false, added: SCHEMA_FIELDS + 4, removed: 0, uncommitted: false },
  ...Array.from({ length: 24 }, (_, i): ChangedFile => ({
    path: `src/photos/step${String(i + 1).padStart(2, '0')}.rs`, oldPath: null, status: 'added', binary: false, added: 4, removed: 0, uncommitted: false,
  })),
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

const SCHEMA_AFTER = [
  '// schema.rs',
  'pub struct Schema;',
  '',
  ...Array.from({ length: SCHEMA_FIELDS }, (_, i) => `pub const FIELD_${String(i + 1).padStart(3, '0')}: u32 = ${i + 1};`),
  '// END_OF_SCHEMA',
  '',
].join('\n');
/** The long demo's pairs: the long file, and a few lines for each small one. */
const LONG_DIFF_PAIRS: Record<string, FilePair> = {
  ...DIFF_PAIRS,
  'src/schema.rs': { original: '', modified: SCHEMA_AFTER, languageHint: 'rust', binary: false },
  ...Object.fromEntries(LONG_DIFF_FILES.slice(1).map((f): [string, FilePair] => [f.path, { original: '', modified: `// ${f.path}\npub fn step() {}\n`, languageHint: 'rust', binary: false }])),
};

// ---- scripted build runs ----

const buildTranscript = (repo: string) =>
  ({ delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-commerce-${MOCK_BUILD_CHANGE}-build-${repo}-20261019T090000Z.jsonl` } }) as ScriptStep;

const LONG_COMMAND = `cd ../${MOCK_MASTER}; C=${MOCK_SYSTEM}/${MOCK_BUILD_CHANGE}; git diff --quiet 150916f8bf1693f32c589f656a3b91c11a716eb0 HEAD -- $C/intent.md; echo intent-pin=$?; git diff --quiet 150916f8bf1693f32c589f656a3b91c11a716eb0 HEAD -- $C/spec.md; echo spec-pin=$?`;

/** The steps for one task: read what it needs, then commit it. */
const taskSteps = (t: PlanTask): ScriptStep[] => [
  { delay: 300, ev: { type: 'tool.use', name: 'Edit', input_summary: `${t.repo}: ${t.name}`, id: `toolu_${t.id}e`, input: { file_path: `${t.repo}/src/lib` } } },
  { delay: 300, ev: { type: 'tool.result', name: 'Edit', ok: true, summary: 'edited', id: `toolu_${t.id}e`, output: 'ok' } },
  { delay: 300, ev: { type: 'tool.use', name: 'Bash', input_summary: `git commit -m "feat(sdlc): ${t.name}"`, id: `toolu_${t.id}c`, input: { command: `git commit -m "feat(sdlc): ${t.name}"` } } },
  { delay: 300, ev: { type: 'tool.result', name: 'Bash', ok: true, summary: `committed ${t.id}`, id: `toolu_${t.id}c`, output: '' } },
];

const completed = (result: string): ScriptStep =>
  ({ delay: 350, ev: { type: 'run.completed', exit_code: 0, is_error: false, num_turns: 3, cost_usd: 0.04, duration_ms: 30000, result } });

/** A round's run: it edits to fix the findings it was given and ends. It starts at once, whatever the other repositories do. */
export function roundRunScript(repo: string): { head: ScriptStep[]; mid: ScriptStep[] } {
  return {
    head: [
      buildTranscript(repo),
      { delay: 300, ev: { type: 'turn', n: 1 } },
      { delay: 300, ev: { type: 'tool.use', name: 'Edit', input_summary: `${repo}: fix the review findings`, id: 'toolu_rfix', input: { file_path: `${repo}/src/upload.ts` } } },
      { delay: 300, ev: { type: 'tool.result', name: 'Edit', ok: true, summary: 'edited', id: 'toolu_rfix', output: 'ok' } },
      completed(`Fixed the findings in ${repo}.`),
    ],
    mid: [],
  };
}

/** A repository run: it does `tasks` and commits each. With `ask`, it pauses on one question before the first task; with `permission`, on one permission check. */
export function buildRunScript(repo: string, tasks: PlanTask[], ask: boolean, permission = false): { head: ScriptStep[]; mid: ScriptStep[] } {
  const read: ScriptStep[] = [
    buildTranscript(repo),
    { delay: 300, ev: { type: 'turn', n: 1 } },
    { delay: 300, ev: { type: 'tool.use', name: 'Read', input_summary: `${MOCK_SYSTEM}/${MOCK_BUILD_CHANGE}/plan.md`, id: 'toolu_plan', input: { file_path: `${MOCK_SYSTEM}/${MOCK_BUILD_CHANGE}/plan.md` } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Read', ok: true, summary: 'plan.md', id: 'toolu_plan', output: '### T1' } },
  ];
  // A real build's commands run far wider than any pane; the browser check needs one to prove nothing scrolls sideways.
  const pins: ScriptStep[] = [
    { delay: 300, ev: { type: 'tool.use', name: 'Bash', input_summary: LONG_COMMAND, id: 'toolu_pins', input: { command: LONG_COMMAND } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Bash', ok: true, summary: 'pins hold', id: 'toolu_pins', output: 'intent-pin=0\nspec-pin=0' } },
  ];
  const work = [...pins, ...tasks.flatMap(taskSteps), completed(`${tasks.length} task(s) done in ${repo}.`)];
  if (permission) return { head: [...read, { delay: 300, ev: { type: 'permission.requested', id: 'p1', ...PENDING_PERMISSION } }], mid: work };
  if (!ask) return { head: [...read, ...work], mid: [] };
  const question: ScriptStep = { delay: 300, ev: { type: 'ask.requested', id: 'q1', questions: [
    { kind: 'select', header: 'picker', question: 'The product form already has a file picker. Reuse it for photos?',
      options: [ { label: 'Reuse it', description: 'smaller change' }, { label: 'Build a new one', description: 'matches the plan text' } ],
      multi_select: false },
  ] } };
  return { head: [...read, question], mid: work };
}

/** What the demo's findings concern, in turn. */
const CONCERNS: Concern[] = ['spec', 'bug', 'convention'];

/** The two findings the scripted review closes with, in the order it lists them. */
const REVIEW_FINDINGS = ['The upload limit is duplicated in commerce-core and customer-portal.', 'The refusal message has no test.'];
/** The severity of each finding, in turn: mostly medium, with a high one and some low ones (the short demo has only the first two findings). */
const SEVERITIES: Severity[] = ['medium', 'medium', 'high', 'low', 'medium', 'low'];
/** The finding (by position) that names no repository. */
const NO_REPO_FINDING = 4;
/** The long demo's review record: the same two findings first, then enough more to overflow the findings area. */
const LONG_REVIEW_FINDINGS = [
  ...REVIEW_FINDINGS,
  'The photo count is read twice for one product, once in the store and once in the billing summary, and the two reads can disagree whenever a photo is replaced while the page is still loading the product.',
  'A file with an upper-case extension such as PHOTO.JPG is refused as not a JPEG.',
  'The size limit is checked after the whole photo is read into memory instead of while it is read.',
  'The remove button on the picker has no accessible name.',
  'The billing summary counts a photo twice when it is replaced and not removed first.',
  'The refusal reason is logged with the file name, which can hold a seller name.',
  'The monthly report export has no test for a product with no photos.',
  'The limit message is not translated like the other messages on the product form.',
  'A product loaded from the cache skips the photo count.',
  'The photo picker keeps a removed photo in the form state until the page is left.',
];

/** The review run: reads the change and closes with two findings. */
export const reviewRunScript: { head: ScriptStep[]; mid: ScriptStep[] } = {
  head: [
    { delay: 250, ev: { type: 'log', level: 'info', message: `transcript: ${TRANSCRIPT_DIR}/sdlc-commerce-${MOCK_BUILD_CHANGE}-review-20261019T093000Z.jsonl` } },
    { delay: 300, ev: { type: 'turn', n: 1 } },
    { delay: 300, ev: { type: 'tool.use', name: 'Bash', input_summary: 'git diff origin/main...HEAD', id: 'toolu_rv1', input: { command: 'git diff origin/main...HEAD' } } },
    { delay: 300, ev: { type: 'tool.result', name: 'Bash', ok: true, summary: '5 files changed', id: 'toolu_rv1', output: '' } },
    completed(`2 findings. ${REVIEW_FINDINGS.map((text, i) => `${i + 1}. ${text}`).join(' ')}`),
  ],
  mid: [],
};

/** The label the plugin's answer gives a change at a stage, for a test that needs one without a change. */
export const mockLabel = (stage: string): StageLabel => ({ ...LABEL_DATA[stage] });

/** The repositories each demo change builds in: the first builds in two (one of them asks a question), the second in one the first does not use, and the held one needs a repository the first holds. */
export const BUILD_REPOS_OF: Record<string, string[]> = {
  [MOCK_BUILD_CHANGE]: ['commerce-core', 'customer-portal'],
  [MOCK_BUILD_SECOND]: ['billing-api'],
  [MOCK_HELD_CHANGE]: ['commerce-core'],
};

/** The backend's key of a change, as the scripted host builds it. */
export function mockChangeKey(ref: ChangeRef): ChangeKey {
  const key = ref.workspace.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return { workspace: { key, name: key.split('/').pop() ?? key }, system: ref.system, change: ref.change };
}

const sameChange = (a: ChangeKey, b: ChangeKey): boolean => a.workspace.key === b.workspace.key && a.system === b.system && a.change === b.change;

/** One change's scripted build as the strip reads it. */
export interface MockBuildView {
  change: ChangeKey;
  state: BuildState | null;
  /** The runs of the build that are live: the repository (or `review`) and the run's id. */
  going: { repo: string; runId: string }[];
  reviewWaiting: HeldRepo[];
  heldStart: HeldRepo[];
  changedMs: number;
}

interface MockBuild {
  key: ChangeKey;
  ref: ChangeRef;
  /** The live runs: a repository's name (or `review`) to the run's id, empty until the launch has answered. */
  going: Map<string, string>;
  stopped: Map<string, { task: string; reason: string; held: boolean }>;
  /** The rounds asked for and not finished: repository to instructions. */
  rounds: Map<string, string>;
  phase: BuildPhase;
  reviewing: boolean;
  /** The repositories whose cancel was asked for, so their run's end reads as a cancel. */
  cancelling: Set<string>;
  cancelledAll: boolean;
  /** The build log rows when the review last ran, and whether a round committed since. */
  reviewedRows: number | null;
  changed: boolean;
  waiting: WaitingRepo[];
  report: StopReport | null;
  changedMs: number;
  /** The form the build started with, for a start again. */
  form: StartForm;
}

/** What the scripted build host asks of the browser stand-in: start a run, stop one, read the build log, say a build's state. */
export interface MockBuildIo {
  /** Start the scripted run of `repo` (`review` for the review) and call `onEnd` when it ends; resolves to the run's id. `instructions` is a round's. */
  launch(change: ChangeRef, repo: string, onEnd: () => void, instructions?: string): string;
  /** Stop a live run. */
  cancel(runId: string): void;
  /** The build log of a change the scripted host sequences by it; null for a change that only runs its repositories once. */
  status(change: ChangeRef): BuildStatus | null;
  announce(event: BuildEvent): void;
  now(): number;
}

const NO_FORM: StartForm = { timeoutSecs: 7200 };

/** The browser's stand-in for the backend's build host: several changes build at once, each holding the repositories it works in, and a build that needs a held repository starts held. A change with a build log is sequenced by it, the way the coordinator does. */
export class MockBuildHost {
  private readonly builds = new Map<string, MockBuild>();
  private readonly holds = new Map<string, ChangeKey>();
  private readonly heldStarts = new Map<string, { key: ChangeKey; held: HeldRepo[]; at: number }>();
  private readonly reviewWaits = new Map<string, { key: ChangeKey; held: HeldRepo[]; at: number }>();

  constructor(private readonly io: MockBuildIo) {}

  private id(key: ChangeKey): string { return `${key.workspace.key}|${key.system}|${key.change}`; }

  private heldBy(key: ChangeKey, repos: string[]): HeldRepo[] {
    return repos.flatMap((repo) => {
      const holder = this.holds.get(repo);
      return holder && !sameChange(holder, key) ? [{ repo, holder }] : [];
    });
  }

  private stateOf(build: MockBuild): BuildState {
    return {
      phase: build.phase,
      going: [...build.going.keys()].sort(),
      stopped: Object.fromEntries(build.stopped),
      rounds: Object.fromEntries(build.rounds),
      waiting: build.waiting,
      report: build.report,
    };
  }

  private announce(build: MockBuild): void {
    build.changedMs = this.io.now();
    this.io.announce({
      change: build.key,
      state: this.stateOf(build),
      reviewWaiting: this.reviewWaits.get(this.id(build.key))?.held ?? [],
      runs: this.runsOf(build),
    });
  }

  private runsOf(build: MockBuild): BuildRunRef[] {
    return [...build.going].flatMap(([key, run]) => (run === '' ? [] : [{ key, run }]));
  }

  private launch(build: MockBuild, repo: string): void {
    // The run's id is known once it is launched; a scripted run never ends before that.
    build.going.set(repo, '');
    const instructions = build.rounds.get(repo);
    const runId = this.io.launch(build.ref, repo, () => this.ended(build, repo), instructions);
    if (build.going.has(repo)) build.going.set(repo, runId);
  }

  private releaseHolds(build: MockBuild): void {
    for (const [repo, holder] of [...this.holds]) if (sameChange(holder, build.key)) this.holds.delete(repo);
  }

  private ended(build: MockBuild, repo: string): void {
    if (!build.going.delete(repo)) return;
    const cancelled = build.cancelling.delete(repo);
    const status = this.io.status(build.ref);
    if (status === null) {
      if (build.going.size === 0) {
        build.phase = 'finished';
        this.releaseHolds(build);
      }
      this.announce(build);
      return;
    }
    if (repo === 'review') {
      build.reviewing = false;
      if (cancelled) build.stopped.set('review', { task: 'review', reason: 'Stopped: cancelled', held: false });
      else build.reviewedRows = status.tasks.filter((t) => t.row !== null).length;
    } else if (cancelled) {
      build.stopped.set(repo, { task: this.taskOf(status, repo), reason: 'Stopped: cancelled', held: false });
    } else if (build.rounds.delete(repo)) {
      // A round commits its fixes, which makes the last review out of date.
      build.changed = true;
    }
    this.look(build, status);
  }

  private taskOf(status: BuildStatus, repo: string): string {
    const state = status.repos.find((r) => r.repo === repo)?.state;
    return state?.kind === 'done' || state === undefined ? '' : state.task;
  }

  /** Start what is ready, or settle the build: the coordinator's loop in miniature. */
  private look(build: MockBuild, status: BuildStatus): void {
    if (build.cancelledAll) {
      if (build.going.size === 0) build.phase = 'cancelled';
      this.announce(build);
      return;
    }
    const waiting: WaitingRepo[] = [];
    const ready: string[] = [];
    for (const r of status.repos) {
      if (r.state.kind === 'waiting') {
        waiting.push({ repo: r.repo, task: r.state.task, onTask: r.state.onTask, onRepo: r.state.onRepo });
        continue;
      }
      if (build.going.has(r.repo)) continue;
      if (r.state.kind === 'done' && !build.rounds.has(r.repo)) continue;
      const task = r.state.kind === 'ready' ? r.state.task : '';
      const stop = build.stopped.get(r.repo);
      if (stop && stop.task === task) continue;
      ready.push(r.repo);
    }
    build.waiting = waiting;
    for (const repo of ready) this.launch(build, repo);
    if (ready.length > 0) {
      build.phase = 'building';
      this.announce(build);
      return;
    }
    if (build.going.size > 0 || build.reviewing) {
      this.announce(build);
      return;
    }
    const rows = status.tasks.filter((t) => t.row !== null).length;
    const complete = status.hasTasks && rows === status.tasks.length;
    if (!complete || build.stopped.size > 0) {
      build.phase = 'stopped';
      build.report = {
        unfinished: [...new Set(status.tasks.filter((t) => t.row === null).map((t) => t.repo))].map((repo) => ({ repo, tasks: status.tasks.filter((t) => t.repo === repo && t.row === null).map((t) => t.id) })),
        waiting,
      };
      this.releaseHolds(build);
      this.announce(build);
      return;
    }
    if (build.reviewedRows === rows && !build.changed) {
      build.phase = 'finished';
      this.releaseHolds(build);
      this.announce(build);
      return;
    }
    build.changed = false;
    build.reviewing = true;
    build.phase = 'reviewing';
    this.launch(build, 'review');
    this.announce(build);
  }

  private fresh(ref: ChangeRef, key: ChangeKey, form: StartForm): MockBuild {
    const rounds = new Map((form.rounds ?? []).map((r) => [r.repo, r.instructions]));
    return {
      key, ref, going: new Map(), stopped: new Map(), rounds, phase: 'building', reviewing: false, cancelling: new Set(), cancelledAll: false,
      reviewedRows: null, changed: false, waiting: [], report: null, changedMs: this.io.now(), form,
    };
  }

  start(ref: ChangeRef, form: StartForm = NO_FORM): StartOutcome {
    const key = mockChangeKey(ref);
    const id = this.id(key);
    if (this.builds.get(id)?.going.size) return { kind: 'alreadyRunning' };
    const status = this.io.status(ref);
    const repos = [...new Set([...(BUILD_REPOS_OF[ref.change] ?? []), ...(form.rounds ?? []).map((r) => r.repo)])];
    const held = this.heldBy(key, repos);
    if (held.length > 0) {
      this.heldStarts.set(id, { key, held, at: this.io.now() });
      return { kind: 'held', held };
    }
    this.heldStarts.delete(id);
    const previous = this.builds.get(id);
    const build = this.fresh(ref, key, form);
    // A build started again keeps what it already reviewed: nothing new to review means no new review.
    if (previous) build.reviewedRows = previous.reviewedRows;
    this.builds.set(id, build);
    for (const repo of repos) this.holds.set(repo, key);
    if (status === null) {
      for (const repo of repos) this.launch(build, repo);
      this.announce(build);
    } else {
      this.look(build, status);
    }
    return { kind: 'started', uncommitted: {} };
  }

  /** Run one repository (or the review) of a build again after it stopped. */
  continueRepo(ref: ChangeRef, repo: string): StartOutcome {
    const key = mockChangeKey(ref);
    const build = this.builds.get(this.id(key));
    if (!build) return this.start(ref);
    if (build.going.has(repo)) return { kind: 'alreadyRunning' };
    build.stopped.delete(repo);
    build.cancelledAll = false;
    for (const r of repoKeys(build)) this.holds.set(r, key);
    const status = this.io.status(ref);
    if (status === null) {
      this.launch(build, repo);
      this.announce(build);
    } else if (repo === 'review') {
      build.reviewing = true;
      build.phase = 'reviewing';
      this.launch(build, 'review');
      this.announce(build);
    } else {
      this.look(build, status);
    }
    return { kind: 'started', uncommitted: {} };
  }

  /** Stop one run of a build, or every run when no repository is named. */
  cancel(ref: ChangeRef, repo: string | null): void {
    const build = this.builds.get(this.id(mockChangeKey(ref)));
    if (!build) return;
    if (repo === null) build.cancelledAll = true;
    const keys = repo === null ? [...build.going.keys()] : build.going.has(repo) ? [repo] : [];
    for (const key of keys) {
      build.cancelling.add(key);
      this.io.cancel(build.going.get(key) ?? '');
    }
    if (repo === null && keys.length === 0) {
      build.phase = 'cancelled';
      this.announce(build);
    }
  }

  state(ref: ChangeRef): BuildState | null {
    const build = this.builds.get(this.id(mockChangeKey(ref)));
    return build ? this.stateOf(build) : null;
  }

  runs(ref: ChangeRef): BuildRunRef[] {
    const build = this.builds.get(this.id(mockChangeKey(ref)));
    return build ? this.runsOf(build) : [];
  }

  reviewStart(ref: ChangeRef): StartOutcome {
    const key = mockChangeKey(ref);
    const id = this.id(key);
    const held = this.heldBy(key, BUILD_REPOS_OF[ref.change] ?? []);
    if (held.length > 0) {
      this.reviewWaits.set(id, { key, held, at: this.io.now() });
      return { kind: 'held', held };
    }
    this.reviewWaits.delete(id);
    const build = this.builds.get(id) ?? this.fresh(ref, key, NO_FORM);
    this.builds.set(id, build);
    build.reviewing = true;
    build.phase = 'reviewing';
    this.launch(build, 'review');
    this.announce(build);
    return { kind: 'started', uncommitted: {} };
  }

  reviewWaiting(ref: ChangeRef): HeldRepo[] {
    return this.reviewWaits.get(this.id(mockChangeKey(ref)))?.held ?? [];
  }

  /** Every build, review wait and held start, for the running changes. */
  views(): MockBuildView[] {
    const out: MockBuildView[] = [...this.builds.values()].map((b) => ({
      change: b.key,
      state: this.stateOf(b),
      going: [...b.going].map(([repo, runId]) => ({ repo, runId })),
      reviewWaiting: this.reviewWaits.get(this.id(b.key))?.held ?? [],
      heldStart: [],
      changedMs: b.changedMs,
    }));
    const known = new Set(out.map((v) => this.id(v.change)));
    for (const w of this.reviewWaits.values()) {
      if (!known.has(this.id(w.key))) { known.add(this.id(w.key)); out.push({ change: w.key, state: null, going: [], reviewWaiting: w.held, heldStart: [], changedMs: w.at }); }
    }
    for (const h of this.heldStarts.values()) {
      if (!known.has(this.id(h.key))) out.push({ change: h.key, state: null, going: [], reviewWaiting: [], heldStart: h.held, changedMs: h.at });
    }
    return out;
  }
}

const repoKeys = (build: MockBuild): string[] => BUILD_REPOS_OF[build.ref.change] ?? [];

// ---- the review and the round, as the backend answers them

const RANK: Record<RoundSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const DEFAULT_PICKED: RoundSeverity[] = ['critical', 'high', 'medium'];

/** The first sentence of a finding's text. */
const firstSentence = (text: string): string => {
  const line = text.split(/\r?\n/)[0];
  const stop = line.indexOf('. ');
  return stop === -1 ? line : line.slice(0, stop + 1);
};

/** A finding of the review record as the offer and the rows carry it. */
const toReviewFinding = (f: ParsedFinding): ReviewFinding => ({
  id: f.id, severity: f.severity, text: f.text, file: f.file, line: f.line, ...(f.repo === undefined ? {} : { repo: f.repo }),
  ...(f.concern === undefined ? {} : { concern: f.concern }), ...(f.rule === undefined ? {} : { rule: f.rule }),
});

/** What a round may fix, from the review record: every finding of the latest review, in the order listed. */
export function mockRoundOffer(record: ReviewRecord | null, repos: string[]): RoundOffer {
  const latest = record?.reviews.at(-1);
  if (!latest) return { review: null, repos, findings: [] };
  return {
    review: latest.number,
    repos,
    findings: latest.findings.map((f, i) => {
      const finding = toReviewFinding(f);
      return { key: f.id || `#${i + 1}`, finding, repo: finding.repo !== undefined && repos.includes(finding.repo) ? finding.repo : null };
    }),
  };
}

/** The findings picked when the dialog opens: critical, high and medium. */
export const mockDefaultPicks = (offer: RoundOffer): RoundPicks => ({
  picked: offer.findings.filter((f) => f.finding.severity !== null && DEFAULT_PICKED.includes(f.finding.severity)).map((f) => f.key),
  assigned: {},
  notes: {},
});

/** One request per repository with a picked finding or a note, or why the round cannot start. */
export function mockRoundPlan(offer: RoundOffer, picks: RoundPicks): RoundPlan {
  const picked = offer.findings.filter((f) => picks.picked.includes(f.key)).map((f) => ({ f, repo: f.repo ?? picks.assigned[f.key] ?? null }));
  const unassigned = picked.filter((p) => p.repo === null).map((p) => p.f.key);
  if (unassigned.length > 0) return { blocked: `Choose a repository for ${unassigned.join(', ')}.`, requests: [] };
  const requests: RoundRequest[] = [];
  for (const repo of offer.repos) {
    const mine = picked.filter((p) => p.repo === repo).map((p) => p.f);
    const note = (picks.notes[repo] ?? '').trim();
    if (mine.length === 0 && note === '') continue;
    const keys = mine.map((f) => f.key).join(', ');
    const text = mine.length === 0 ? '' : `Fix these findings from review ${offer.review ?? ''} of this change in this repository.\n${mine.map((f) => `- ${f.key} ${f.finding.text}`).join('\n')}`;
    requests.push({ repo, instructions: [text, note === '' ? '' : `Also from the engineer:\n${note}`].filter((p) => p !== '').join('\n\n'), summary: [repo, ...(keys === '' ? [] : [keys]), ...(note === '' ? [] : ['with a note'])].join(' · ') });
  }
  if (requests.length === 0) return { blocked: 'Pick a finding or write a note.', requests: [] };
  return { blocked: null, requests };
}

/** The Review group for the latest review: most serious first, the low findings apart, counts by severity. */
export function mockReviewView(record: ReviewRecord | null, repos: string[]): ReviewView {
  const offer = mockRoundOffer(record, repos);
  const row = (f: RoundOffer['findings'][number]): ReviewRow => ({ key: f.key, finding: f.finding, summary: firstSentence(f.finding.text) });
  const named = [...repos, ...offer.findings.flatMap((f) => (f.finding.repo !== undefined && !repos.includes(f.finding.repo) ? [f.finding.repo] : []))];
  const places: (string | null)[] = [...new Set(named), null];
  const groups: ReviewRowGroup[] = places.flatMap((repo) => {
    const mine = offer.findings.filter((f) => (f.finding.repo ?? null) === repo);
    if (mine.length === 0) return [];
    return [{
      repo,
      rows: mine.filter((f) => f.finding.severity !== 'low').sort((a, b) => (a.finding.severity === null ? 4 : RANK[a.finding.severity]) - (b.finding.severity === null ? 4 : RANK[b.finding.severity])).map(row),
      low: mine.filter((f) => f.finding.severity === 'low').map(row),
    }];
  });
  const counts = (['critical', 'high', 'medium', 'low'] as const).map((severity) => ({ severity, n: offer.findings.filter((f) => f.finding.severity === severity).length })).filter((c) => c.n > 0);
  const byKey = new Map(offer.findings.map((f) => [f.key, f]));
  return {
    rows: { counts, total: offer.findings.length, groups },
    groups: groups.map((g) => ({ repo: g.repo, findings: [...g.rows, ...g.low].flatMap((r) => byKey.get(r.key) ?? []) })),
  };
}
