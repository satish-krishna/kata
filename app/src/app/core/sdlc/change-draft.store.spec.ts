import { TestBed } from '@angular/core/testing';
import type { ChangeRef } from '@bindings/ChangeRef';
import { ChangeDraftStore } from './change-draft.store';

const B: ChangeRef = { workspace: 'D:/ws', system: 'shop', change: 'b' };
const C: ChangeRef = { workspace: 'D:/ws', system: 'shop', change: 'c' };

describe('ChangeDraftStore', () => {
  const store = () => TestBed.inject(ChangeDraftStore);

  it('a typed message and the open tab come back', () => {
    const drafts = store();
    drafts.setMessage(B, 'run-1', 'please also cover the empty cart');
    drafts.setTab(B, 'spec');
    drafts.setPick(B, { kind: 'repo', repo: 'kata' });
    expect(drafts.message(B, 'run-1')).toBe('please also cover the empty cart');
    expect(drafts.tab(B)).toBe('spec');
    expect(drafts.pick(B)).toEqual({ kind: 'repo', repo: 'kata' });
  });

  it('a sent message clears its draft', () => {
    const drafts = store();
    drafts.setMessage(B, 'run-1', 'one');
    drafts.setMessage(B, 'run-2', 'two');
    drafts.clearMessage(B, 'run-1');
    expect(drafts.message(B, 'run-1')).toBe('');
    expect(drafts.message(B, 'run-2')).toBe('two');
    drafts.setMessage(B, 'run-2', '');
    expect(drafts.message(B, 'run-2')).toBe('');
  });

  it('drafts of two changes stay apart', () => {
    const drafts = store();
    drafts.setMessage(B, 'run-1', 'for b');
    drafts.setTab(B, 'plan');
    drafts.setMessage(C, 'run-1', 'for c');
    expect(drafts.message(B, 'run-1')).toBe('for b');
    expect(drafts.message(C, 'run-1')).toBe('for c');
    expect(drafts.tab(C)).toBeNull();
    expect(drafts.pick(C)).toBeNull();
  });
});
