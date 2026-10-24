import { describe, expect, it } from 'vitest';
import type { BuildStage } from './build-stage';
import type { LayoutMode } from './build-layout';
import { layoutStage, onStageChange, suitedMode, type LayoutStage } from './build-layout-stage';

type ReviewEntry = 'not run' | 'running' | 'finished' | 'stale';

describe('layoutStage', () => {
  // Impossible and left out: review-finished or done with a review entry of running. The entry is running only while the phase is reviewing, which makes the stage reviewing.
  const rows: [BuildStage, boolean, ReviewEntry, LayoutStage][] = [
    ['not-started', false, 'not run', 'stopped'],
    ['not-started', false, 'running', 'stopped'],
    ['not-started', false, 'finished', 'stopped'],
    ['not-started', false, 'stale', 'stopped'],
    ['not-started', true, 'not run', 'stopped'],
    ['not-started', true, 'running', 'stopped'],
    ['not-started', true, 'finished', 'stopped'],
    ['not-started', true, 'stale', 'stopped'],
    ['running', false, 'not run', 'started'],
    ['running', false, 'running', 'started'],
    ['running', false, 'finished', 'started'],
    ['running', false, 'stale', 'started'],
    ['running', true, 'not run', 'running'],
    ['running', true, 'running', 'running'],
    ['running', true, 'finished', 'running'],
    ['running', true, 'stale', 'running'],
    ['running-one-stopped', false, 'not run', 'started'],
    ['running-one-stopped', false, 'running', 'started'],
    ['running-one-stopped', false, 'finished', 'started'],
    ['running-one-stopped', false, 'stale', 'started'],
    ['running-one-stopped', true, 'not run', 'running'],
    ['running-one-stopped', true, 'running', 'running'],
    ['running-one-stopped', true, 'finished', 'running'],
    ['running-one-stopped', true, 'stale', 'running'],
    ['reviewing', false, 'not run', 'running'],
    ['reviewing', false, 'running', 'running'],
    ['reviewing', false, 'finished', 'running'],
    ['reviewing', false, 'stale', 'running'],
    ['reviewing', true, 'not run', 'running'],
    ['reviewing', true, 'running', 'running'],
    ['reviewing', true, 'finished', 'running'],
    ['reviewing', true, 'stale', 'running'],
    ['stopped', false, 'not run', 'stopped'],
    ['stopped', false, 'running', 'stopped'],
    ['stopped', false, 'finished', 'stopped'],
    ['stopped', false, 'stale', 'stopped'],
    ['stopped', true, 'not run', 'stopped'],
    ['stopped', true, 'running', 'stopped'],
    ['stopped', true, 'finished', 'stopped'],
    ['stopped', true, 'stale', 'stopped'],
    ['cancelled', false, 'not run', 'stopped'],
    ['cancelled', false, 'running', 'stopped'],
    ['cancelled', false, 'finished', 'stopped'],
    ['cancelled', false, 'stale', 'stopped'],
    ['cancelled', true, 'not run', 'stopped'],
    ['cancelled', true, 'running', 'stopped'],
    ['cancelled', true, 'finished', 'stopped'],
    ['cancelled', true, 'stale', 'stopped'],
    ['review-finished', false, 'not run', 'stopped'],
    ['review-finished', false, 'finished', 'finished'],
    ['review-finished', false, 'stale', 'finished'],
    ['review-finished', true, 'not run', 'stopped'],
    ['review-finished', true, 'finished', 'finished'],
    ['review-finished', true, 'stale', 'finished'],
    ['done', false, 'not run', 'stopped'],
    ['done', false, 'finished', 'finished'],
    ['done', false, 'stale', 'finished'],
    ['done', true, 'not run', 'stopped'],
    ['done', true, 'finished', 'finished'],
    ['done', true, 'stale', 'finished'],
  ];

  it('has the 60 possible combinations', () => {
    expect(rows).toHaveLength(60);
  });

  it.each(rows)('stage %s, recorded %s, review %s gives %s', (stage, recorded, review, expected) => {
    expect(layoutStage({ stage, recorded, review })).toBe(expected);
  });
});

describe('suitedMode', () => {
  it.each<[LayoutStage, LayoutMode]>([
    ['started', 'overview'],
    ['running', 'watch'],
    ['stopped', 'overview'],
    ['finished', 'review'],
  ])('%s gives %s', (stage, mode) => {
    expect(suitedMode(stage)).toBe(mode);
  });
});

describe('onStageChange', () => {
  type Outcome = { move: LayoutMode | null; suggested: LayoutMode | null };
  type Row = { to: LayoutStage; mode: LayoutMode; handSwitched: boolean } & Outcome;
  const table: Row[] = [
    { to: 'started', mode: 'watch', handSwitched: false, move: 'overview', suggested: null },
    { to: 'running', mode: 'overview', handSwitched: false, move: 'watch', suggested: null },
    { to: 'finished', mode: 'watch', handSwitched: false, move: 'review', suggested: null },
    { to: 'started', mode: 'overview', handSwitched: false, move: null, suggested: null },
    { to: 'running', mode: 'watch', handSwitched: false, move: null, suggested: null },
    { to: 'finished', mode: 'review', handSwitched: false, move: null, suggested: null },
    { to: 'started', mode: 'changes', handSwitched: true, move: null, suggested: 'overview' },
    { to: 'running', mode: 'changes', handSwitched: true, move: null, suggested: 'watch' },
    { to: 'finished', mode: 'changes', handSwitched: true, move: null, suggested: 'review' },
    { to: 'started', mode: 'overview', handSwitched: true, move: null, suggested: null },
    { to: 'running', mode: 'watch', handSwitched: true, move: null, suggested: null },
    { to: 'finished', mode: 'review', handSwitched: true, move: null, suggested: null },
    { to: 'stopped', mode: 'watch', handSwitched: false, move: null, suggested: 'overview' },
    { to: 'stopped', mode: 'watch', handSwitched: true, move: null, suggested: 'overview' },
    { to: 'stopped', mode: 'overview', handSwitched: false, move: null, suggested: null },
    { to: 'stopped', mode: 'overview', handSwitched: true, move: null, suggested: null },
  ];

  it.each(table)('to $to in $mode, hand switched $handSwitched', ({ to, mode, handSwitched, move, suggested }) => {
    expect(onStageChange({ to, mode, handSwitched })).toEqual({ move, suggested });
  });

  type Case = { before: LayoutStage; mode: LayoutMode; handSwitched: boolean; after: LayoutStage; expected: Outcome };
  const r101: Case[] = [
    { before: 'started', mode: 'overview', handSwitched: false, after: 'running', expected: { move: 'watch', suggested: null } },
    { before: 'started', mode: 'changes', handSwitched: true, after: 'running', expected: { move: null, suggested: 'watch' } },
    { before: 'started', mode: 'overview', handSwitched: false, after: 'stopped', expected: { move: null, suggested: null } },
    { before: 'started', mode: 'watch', handSwitched: true, after: 'stopped', expected: { move: null, suggested: 'overview' } },
    { before: 'running', mode: 'watch', handSwitched: false, after: 'stopped', expected: { move: null, suggested: 'overview' } },
    { before: 'running', mode: 'changes', handSwitched: true, after: 'stopped', expected: { move: null, suggested: 'overview' } },
    { before: 'running', mode: 'watch', handSwitched: false, after: 'finished', expected: { move: 'review', suggested: null } },
    { before: 'running', mode: 'changes', handSwitched: true, after: 'finished', expected: { move: null, suggested: 'review' } },
    { before: 'stopped', mode: 'overview', handSwitched: false, after: 'running', expected: { move: 'watch', suggested: null } },
    { before: 'stopped', mode: 'review', handSwitched: true, after: 'running', expected: { move: null, suggested: 'watch' } },
    { before: 'stopped', mode: 'overview', handSwitched: false, after: 'started', expected: { move: null, suggested: null } },
    { before: 'stopped', mode: 'review', handSwitched: true, after: 'started', expected: { move: null, suggested: 'overview' } },
    { before: 'finished', mode: 'review', handSwitched: false, after: 'running', expected: { move: 'watch', suggested: null } },
    { before: 'finished', mode: 'changes', handSwitched: true, after: 'running', expected: { move: null, suggested: 'watch' } },
  ];

  it('lists the fourteen rows of R10.1', () => {
    expect(r101).toHaveLength(14);
  });

  it.each(r101)('R10.1: $before in $mode (hand $handSwitched) to $after', ({ mode, handSwitched, after, expected }) => {
    expect(onStageChange({ to: after, mode, handSwitched })).toEqual(expected);
  });
});
