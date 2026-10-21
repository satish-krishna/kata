import type { Problem } from '@bindings/Problem';
import type { Readiness } from '@bindings/Readiness';
import { docNotice, type DocNotice } from './doc-notice';

const ready: Readiness = { kind: 'ready', dir: 'plugins/ai-sdlc', version: '0.8.0' };
const problems: Problem[] = [
  { file: 'spec.md', line: 14, message: 'requirement has no ID' },
  { file: 'spec.md', line: 31, message: 'scenario is outside a requirement' },
];

type Row = { name: string; layout: number; problems: Problem[]; readiness: Readiness; notice: DocNotice | null };

/** The table in the plan, written by hand, one entry per row and per branch of a row. */
const ROWS: Row[] = [
  { name: 'plugin missing', layout: 2, problems: [], readiness: { kind: 'missing' }, notice: { tone: 'warning', text: 'Install the ai-sdlc plugin to read this document', lines: [], plain: true } },
  { name: 'plugin missing beats problems and layout', layout: 3, problems, readiness: { kind: 'missing' }, notice: { tone: 'warning', text: 'Install the ai-sdlc plugin to read this document', lines: [], plain: true } },
  { name: 'plugin too old', layout: 2, problems: [], readiness: { kind: 'tooOld', have: '0.6.0', need: '0.8.0' }, notice: { tone: 'warning', text: 'Update the ai-sdlc plugin to 0.8.0 or later', lines: [], plain: true } },
  { name: 'plugin too old names the version it needs', layout: 1, problems: [], readiness: { kind: 'tooOld', have: '0.7.0', need: '0.9.1' }, notice: { tone: 'warning', text: 'Update the ai-sdlc plugin to 0.9.1 or later', lines: [], plain: true } },
  { name: 'newer layout', layout: 3, problems: [], readiness: ready, notice: { tone: 'warning', text: 'This document needs a newer Workbench', lines: [], plain: false } },
  { name: 'newer layout with problems still says newer', layout: 4, problems, readiness: ready, notice: { tone: 'warning', text: 'This document needs a newer Workbench', lines: [], plain: false } },
  { name: 'layout 1 without problems', layout: 1, problems: [], readiness: ready, notice: { tone: 'idle', text: 'Older layout', lines: [], plain: false } },
  { name: 'layout 2 without problems', layout: 2, problems: [], readiness: ready, notice: null },
  {
    name: 'layout 2 with problems',
    layout: 2,
    problems,
    readiness: ready,
    notice: { tone: 'warning', text: 'This document does not follow the layout', lines: ['line 14: requirement has no ID', 'line 31: scenario is outside a requirement'], plain: false },
  },
];

describe('docNotice', () => {
  for (const row of ROWS) {
    it(`${row.name}`, () => {
      expect(docNotice(row.layout, row.problems, row.readiness)).toEqual(row.notice);
    });
  }
});
