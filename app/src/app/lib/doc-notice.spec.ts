import type { Problem } from '@bindings/Problem';
import type { ReadResult } from '@bindings/ReadResult';
import type { Readiness } from '@bindings/Readiness';
import { shownBuild, shownChangeList, shownDocument, shownPart, type DocNotice, type Part, type ReadError, type Shown } from './doc-notice';

/* The owner of "the Workbench never shows less than a document holds without saying so", tested row by row against
 * the table in the plan, written by hand. */

const ready: Extract<Readiness, { kind: 'ready' }> = { kind: 'ready', dir: 'plugins/ai-sdlc', version: '0.8.0', layouts: [1, 2] };
const problems: Problem[] = [
  { file: 'spec.md', line: 14, message: 'requirement has no ID' },
  { file: 'spec.md', line: 31, message: 'scenario is outside a requirement' },
];
const lines = ['line 14: requirement has no ID', 'line 31: scenario is outside a requirement'];
const filed = ['spec.md line 14: requirement has no ID', 'spec.md line 31: scenario is outside a requirement'];
const read = (layout: number, over: Problem[] = []): ReadResult => ({ kind: 'spec', layout, document: { requirements: [] }, problems: over });
const error: ReadError = { kind: 'error', message: 'front matter is not closed' };
const warn = (text: string, withLines: string[] = []): DocNotice => ({ tone: 'warning', text, lines: withLines });
const INSTALL = warn('Install the ai-sdlc plugin to read this document');
const NEWER = warn('This document needs a newer Workbench');

type Row = { name: string; read: ReadResult | ReadError | null; readiness: Readiness; shown: Shown };

/** One entry per row of the table and per branch of a row. */
const ROWS: Row[] = [
  { name: 'plugin missing, a document read', read: read(2), readiness: { kind: 'missing' }, shown: { show: 'plain', notice: INSTALL } },
  { name: 'plugin missing, nothing read', read: null, readiness: { kind: 'missing' }, shown: { show: 'plain', notice: INSTALL } },
  { name: 'plugin missing beats an error', read: error, readiness: { kind: 'missing' }, shown: { show: 'plain', notice: INSTALL } },
  { name: 'plugin missing beats problems and a newer layout', read: read(3, problems), readiness: { kind: 'missing' }, shown: { show: 'plain', notice: INSTALL } },
  { name: 'plugin too old', read: read(2), readiness: { kind: 'tooOld', have: '0.6.0', need: '0.8.0' }, shown: { show: 'plain', notice: warn('Update the ai-sdlc plugin to 0.8.0 or later') } },
  { name: 'plugin too old names the version it needs', read: error, readiness: { kind: 'tooOld', have: '0.7.0', need: '0.9.1' }, shown: { show: 'plain', notice: warn('Update the ai-sdlc plugin to 0.9.1 or later') } },
  { name: 'ready, the program could not read the document (F4)', read: error, readiness: ready, shown: { show: 'plain', notice: warn('Could not read this document: front matter is not closed') } },
  { name: 'ready, layout not accepted', read: read(3), readiness: ready, shown: { show: 'parsed', notice: NEWER } },
  { name: 'ready, layout not accepted, with problems', read: read(4, problems), readiness: ready, shown: { show: 'parsed', notice: NEWER } },
  { name: 'ready, accepted layouts come from readiness, not a maximum', read: read(3), readiness: { ...ready, layouts: [2, 3] }, shown: { show: 'parsed', notice: null } },
  { name: 'ready, a layout missing from the accepted list is not accepted', read: read(1), readiness: { ...ready, layouts: [2, 3] }, shown: { show: 'parsed', notice: NEWER } },
  { name: 'ready, accepted layout 2 with problems', read: read(2, problems), readiness: ready, shown: { show: 'parsed', notice: warn('This document does not follow the layout', lines) } },
  { name: 'ready, layout 1 with problems shows the problems, not the label (F3)', read: read(1, problems), readiness: ready, shown: { show: 'parsed', notice: warn('This document does not follow the layout', lines) } },
  { name: 'ready, layout 1 without problems', read: read(1), readiness: ready, shown: { show: 'parsed', notice: { tone: 'idle', text: 'Older layout', lines: [] } } },
  { name: 'ready, layout 2 without problems', read: read(2), readiness: ready, shown: { show: 'parsed', notice: null } },
  { name: 'ready, nothing read (no such document)', read: null, readiness: ready, shown: { show: 'plain', notice: null } },
];

describe('shownDocument', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      expect(shownDocument(row.read, row.readiness)).toEqual(row.shown);
    });
  }
});

describe('shownBuild', () => {
  const older: Part = { layout: 1, problems: [] };
  const current: Part = { layout: 2, problems: [] };

  it('problems from a layout 2 log are not hidden behind the older-layout label of another log (F3)', () => {
    const got = shownBuild([older, { layout: 2, problems }], ready);
    expect(got.notice).toEqual(warn('This document does not follow the layout', filed));
  });

  it('names the file of each problem when the problems span more than one document (F22)', () => {
    const plan: Problem = { file: 'plan.md', line: 5, message: 'task has no repository' };
    const log: Problem = { file: 'build/kata.md', line: 5, message: 'entry recorded twice' };
    const expected = warn('This document does not follow the layout', ['plan.md line 5: task has no repository', 'build/kata.md line 5: entry recorded twice']);
    expect(shownBuild([{ layout: 2, problems: [plan, log] }], ready).notice).toEqual(expected);
    expect(shownBuild([{ layout: 2, problems: [plan] }, { layout: 2, problems: [log] }], ready).notice).toEqual(expected);
  });

  it('names the file of each problem even when every problem comes from one document (F24)', () => {
    const log: Problem = { file: 'build/kata.md', line: 14, message: 'entry T7 has no commits' };
    expect(shownBuild([{ layout: 2, problems: [log] }], ready).notice).toEqual(warn('This document does not follow the layout', ['build/kata.md line 14: entry T7 has no commits']));
  });

  it('problems with no layout of their own still show', () => {
    expect(shownBuild([current, { layout: null, problems }], ready).notice).toEqual(warn('This document does not follow the layout', filed));
  });

  it('one older log labels the tab when nothing has problems', () => {
    expect(shownBuild([current, older], ready).notice).toEqual({ tone: 'idle', text: 'Older layout', lines: [] });
  });

  it('a layout not accepted in any part says the Workbench is too old', () => {
    expect(shownBuild([current, { layout: 3, problems: [] }], ready).notice).toEqual(NEWER);
  });

  it('nothing wrong shows no notice', () => {
    expect(shownBuild([current, current], ready).notice).toBeNull();
    expect(shownBuild([], ready).notice).toBeNull();
  });

  it('a plugin that cannot read says so, whatever the parts hold', () => {
    expect(shownBuild([older], { kind: 'missing' }).notice).toEqual(INSTALL);
  });
});

describe('shownPart', () => {
  it('keeps the problems of one document bare, like the Spec and Plan tabs', () => {
    expect(shownPart({ layout: 2, problems }, ready).notice).toEqual(warn('This document does not follow the layout', lines));
  });

  it('gives the plugin rows when the plugin is unusable', () => {
    expect(shownPart({ layout: 2, problems }, { kind: 'missing' }).notice).toEqual(INSTALL);
  });
});

describe('shownChangeList (F26)', () => {
  const list = shownChangeList;
  it('shows nothing when no plan is unreadable', () => {
    expect(list(ready, [])).toBeNull();
  });

  it('words a newer layout as the program does, never as a missing Node.js', () => {
    const message = 'the format program could not run: plan.md: layout 3 is newer than this program reads (it reads 1, 2); update the ai-sdlc plugin';
    const notice = list(ready, [message]);
    expect(notice).toEqual(shownDocument({ kind: 'error', message }, ready).notice);
    expect(notice?.text).toContain('layout 3 is newer');
    expect(notice?.text).not.toContain('Node.js 20');
  });

  it('words a missing Node.js as the program does', () => {
    const message = 'Node.js was not found on this machine; ai-sdlc needs Node.js 20 or later';
    expect(list(ready, [message])?.text).toContain('Node.js was not found');
  });

  it('names each distinct cause once when several plans fail', () => {
    const text = list(ready, ['one cause', 'one cause', 'another cause'])?.text ?? '';
    expect(text.match(/one cause/g)).toHaveLength(1);
    expect(text).toContain('another cause');
  });

  it('keeps the plugin rows above any cause', () => {
    expect(list({ kind: 'missing' }, ['layout 3 is newer'])).toEqual(INSTALL);
  });

  it('falls back to the plain notice when a plan is unreadable and no cause came with it', () => {
    expect(list(ready, [null])?.text).toContain('could not be read');
  });
});
