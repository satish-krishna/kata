import type { Problem } from '@bindings/Problem';
import type { ReadResult } from '@bindings/ReadResult';
import type { Readiness } from '@bindings/Readiness';
import * as docNoticeModule from './doc-notice';

/* The owner of "the Workbench never shows less than a document holds without saying so", tested row by row against
 * the table in the plan, written by hand. */

type Notice = { tone: 'warning' | 'idle'; text: string; lines: string[] };
type Shown = { show: 'plain' | 'parsed'; notice: Notice | null };
type Part = { layout: number | null; problems: readonly Problem[] };
const owner = docNoticeModule as unknown as {
  shownDocument: (read: unknown, readiness: Readiness) => Shown;
  shownBuild: (parts: readonly Part[], readiness: Readiness) => Shown;
};

const ready = { kind: 'ready', dir: 'plugins/ai-sdlc', version: '0.8.0', layouts: [1, 2] } as Readiness;
const problems: Problem[] = [
  { file: 'spec.md', line: 14, message: 'requirement has no ID' },
  { file: 'spec.md', line: 31, message: 'scenario is outside a requirement' },
];
const lines = ['line 14: requirement has no ID', 'line 31: scenario is outside a requirement'];
const read = (layout: number, over: Problem[] = []) => ({ kind: 'spec', layout, document: { requirements: [] }, problems: over }) as ReadResult;
const error = { kind: 'error', message: 'front matter is not closed' };
const warn = (text: string, withLines: string[] = []): Notice => ({ tone: 'warning', text, lines: withLines });
const INSTALL = warn('Install the ai-sdlc plugin to read this document');
const NEWER = warn('This document needs a newer Workbench');

type Row = { name: string; read: unknown; readiness: Readiness; shown: Shown };

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
  { name: 'ready, accepted layouts come from readiness, not a maximum', read: read(3), readiness: { ...ready, layouts: [2, 3] } as unknown as Readiness, shown: { show: 'parsed', notice: null } },
  { name: 'ready, a layout missing from the accepted list is not accepted', read: read(1), readiness: { ...ready, layouts: [2, 3] } as unknown as Readiness, shown: { show: 'parsed', notice: NEWER } },
  { name: 'ready, accepted layout 2 with problems', read: read(2, problems), readiness: ready, shown: { show: 'parsed', notice: warn('This document does not follow the layout', lines) } },
  { name: 'ready, layout 1 with problems shows the problems, not the label (F3)', read: read(1, problems), readiness: ready, shown: { show: 'parsed', notice: warn('This document does not follow the layout', lines) } },
  { name: 'ready, layout 1 without problems', read: read(1), readiness: ready, shown: { show: 'parsed', notice: { tone: 'idle', text: 'Older layout', lines: [] } } },
  { name: 'ready, layout 2 without problems', read: read(2), readiness: ready, shown: { show: 'parsed', notice: null } },
  { name: 'ready, nothing read (no such document)', read: null, readiness: ready, shown: { show: 'plain', notice: null } },
];

describe('shownDocument', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      expect(owner.shownDocument(row.read, row.readiness)).toEqual(row.shown);
    });
  }
});

describe('shownBuild', () => {
  const older: Part = { layout: 1, problems: [] };
  const current: Part = { layout: 2, problems: [] };

  it('problems from a layout 2 log are not hidden behind the older-layout label of another log (F3)', () => {
    const got = owner.shownBuild([older, { layout: 2, problems }], ready);
    expect(got.notice).toEqual(warn('This document does not follow the layout', lines));
  });

  it('problems with no layout of their own still show', () => {
    expect(owner.shownBuild([current, { layout: null, problems }], ready).notice).toEqual(warn('This document does not follow the layout', lines));
  });

  it('one older log labels the tab when nothing has problems', () => {
    expect(owner.shownBuild([current, older], ready).notice).toEqual({ tone: 'idle', text: 'Older layout', lines: [] });
  });

  it('a layout not accepted in any part says the Workbench is too old', () => {
    expect(owner.shownBuild([current, { layout: 3, problems: [] }], ready).notice).toEqual(NEWER);
  });

  it('nothing wrong shows no notice', () => {
    expect(owner.shownBuild([current, current], ready).notice).toBeNull();
    expect(owner.shownBuild([], ready).notice).toBeNull();
  });

  it('a plugin that cannot read says so, whatever the parts hold', () => {
    expect(owner.shownBuild([older], { kind: 'missing' }).notice).toEqual(INSTALL);
  });
});
