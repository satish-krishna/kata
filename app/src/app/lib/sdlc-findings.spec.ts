import type { Finding } from './sdlc';
import { groupFindings } from './sdlc-findings';

const f = (text: string, repo?: string, severity: Finding['severity'] = 'medium'): Finding => ({ severity, text, ...(repo === undefined ? {} : { repo }) });

describe('groupFindings', () => {
  it('none name a repository: one group with no repository, in the order given', () => {
    const list = [f('a'), f('b', undefined, 'high')];
    expect(groupFindings(list, ['api', 'web'])).toEqual([{ repo: null, findings: list }]);
  });

  it('an empty list is one empty group with no repository', () => {
    expect(groupFindings([], ['api'])).toEqual([{ repo: null, findings: [] }]);
  });

  it('closing-text findings (no repository) give one group (R10.1)', () => {
    const words: Finding[] = [
      { severity: null, text: 'T1 done in abc1234' },
      { severity: null, text: 'T2 done in def5678' },
    ];
    expect(groupFindings(words, [])).toEqual([{ repo: null, findings: words }]);
  });

  it('all name one: a group per repository in repos order that has findings, findings keep their order', () => {
    const [w1, a1, w2] = [f('w1', 'web', 'high'), f('a1', 'api'), f('w2', 'web', 'low')];
    expect(groupFindings([w1, a1, w2], ['api', 'db', 'web'])).toEqual([
      { repo: 'api', findings: [a1] },
      { repo: 'web', findings: [w1, w2] },
    ]);
  });

  it('a repository the header lacks comes after the listed ones, in first-seen order', () => {
    const [x1, w1, y1, x2] = [f('x1', 'extra'), f('w1', 'web'), f('y1', 'other'), f('x2', 'extra')];
    expect(groupFindings([x1, w1, y1, x2], ['web'])).toEqual([
      { repo: 'web', findings: [w1] },
      { repo: 'extra', findings: [x1, x2] },
      { repo: 'other', findings: [y1] },
    ]);
  });

  it('some name one: the named groups, then a last group with no repository', () => {
    const [n1, w1, n2] = [f('n1'), f('w1', 'web'), f('n2')];
    expect(groupFindings([n1, w1, n2], ['api', 'web'])).toEqual([
      { repo: 'web', findings: [w1] },
      { repo: null, findings: [n1, n2] },
    ]);
  });

  it("a spec finding about the light track's three-task cap ranks by severity like any other (R8.4)", () => {
    const cap: Finding = { severity: 'high', concern: 'spec', text: "The fix went past the light track's three tasks." };
    const low = f('a typo', undefined, 'low');
    expect(groupFindings([cap, low], [])).toEqual([{ repo: null, findings: [cap, low] }]);
  });
});
