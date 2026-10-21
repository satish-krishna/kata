import type { TaskStatus } from '@bindings/TaskStatus';
import { neededBy, taskFields, taskRecord } from './plan-doc';

// T33 of the real Part 2 plan, shortened: a nested Change bullet, backticks and requirement ids.
const T33 = [
  '### T33: Plan and build stages read from the repositories (`kata`)',
  '',
  '- **Depends on:** T18, T32',
  '- **Files:** `crates/kata-sdlc/src/changes.rs`, `crates/kata-sdlc/src/decide.rs` (publish the scope resolver).',
  '- **Change:**',
  '  - `Stage` replaces `PlanWritten` with `PlanAwaiting`.',
  '  - `pub enum OutOfDate { IntentReopened, SpecReopened }` (kebab-case, TS export).',
  '- **Tests:** failing first because the variants do not exist. Run `cargo test -p kata-sdlc changes`.',
  '  - Rust: `derive_stage_written_plan_awaits_acceptance_r1_1` covers R1.1.',
  '- **Done when:** both suites pass and the app builds.',
].join('\n');

describe('taskFields', () => {
  it('reads each bold-labeled bullet in order, with its continuation lines', () => {
    expect(taskFields(T33)).toEqual([
      { field: 'Depends on', body: 'T18, T32' },
      { field: 'Files', body: '`crates/kata-sdlc/src/changes.rs`, `crates/kata-sdlc/src/decide.rs` (publish the scope resolver).' },
      {
        field: 'Change',
        body: ['- `Stage` replaces `PlanWritten` with `PlanAwaiting`.', '- `pub enum OutOfDate { IntentReopened, SpecReopened }` (kebab-case, TS export).'].join('\n'),
      },
      {
        field: 'Tests',
        body: ['failing first because the variants do not exist. Run `cargo test -p kata-sdlc changes`.', '- Rust: `derive_stage_written_plan_awaits_acceptance_r1_1` covers R1.1.'].join('\n'),
      },
      { field: 'Done when', body: 'both suites pass and the app builds.' },
    ]);
  });

  it('keeps whatever fields the plan has, not a fixed set', () => {
    expect(taskFields('### T1: x (`a`)\n\n- **Depends on:** none\n- **Notes:** careful\n')).toEqual([
      { field: 'Depends on', body: 'none' },
      { field: 'Notes', body: 'careful' },
    ]);
  });

  it('is empty for text with no field bullets, and ignores lines before the first one', () => {
    expect(taskFields('### T1: x (`a`)\n\nSome prose.\n')).toEqual([]);
    expect(taskFields('')).toEqual([]);
  });

  it('reads Windows line endings', () => {
    expect(taskFields('### T1: x (`a`)\r\n\r\n- **Files:** a.rs\r\n- **Change:** b\r\n')).toEqual([
      { field: 'Files', body: 'a.rs' },
      { field: 'Change', body: 'b' },
    ]);
  });
});

const task = (id: string, dependsOn: string[], row: TaskStatus['row'] = null): TaskStatus => ({
  id, name: `Task ${id}`, repo: 'kata', dependsOn, text: `### ${id}`, row,
});

describe('neededBy', () => {
  const tasks = [task('T31', []), task('T18', []), task('T32', ['T18']), task('T33', ['T18', 'T32']), task('T34', ['T33'])];

  it('lists the tasks whose Depends on names the task, in plan order', () => {
    expect(neededBy(tasks, 'T18')).toEqual(['T32', 'T33']);
    expect(neededBy(tasks, 'T32')).toEqual(['T33']);
    expect(neededBy(tasks, 'T33')).toEqual(['T34']);
  });

  it('is empty for a task nothing depends on, or an id the plan does not have', () => {
    expect(neededBy(tasks, 'T34')).toEqual([]);
    expect(neededBy(tasks, 'T31')).toEqual([]);
    expect(neededBy(tasks, 'T99')).toEqual([]);
  });
});

describe('taskRecord', () => {
  it('reads a task with no row as not built yet', () => {
    expect(taskRecord(task('T1', []))).toEqual({ kind: 'unbuilt', label: 'Not built yet', text: null });
  });

  it('reads a row with no departure as built as planned', () => {
    const row = { task: 'T1', repo: 'kata', commits: ['abc1234'], departure: null };
    expect(taskRecord(task('T1', [], row))).toEqual({ kind: 'planned', label: 'As planned', text: null });
  });

  it('reads a row with a departure as differing from the plan, carrying the departure text', () => {
    const row = { task: 'T1', repo: 'kata', commits: ['abc1234'], departure: 'Used a Map, not an array.' };
    expect(taskRecord(task('T1', [], row))).toEqual({ kind: 'differs', label: 'Differs from plan', text: 'Used a Map, not an array.' });
  });
});
