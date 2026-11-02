import type { OpenRun } from '@bindings/OpenRun';
import { render } from '../../testing/render';
import type { RunChoice, StripPick, StripRow } from '../lib/running-strip';
import { RunningStrip } from './running-strip';

const open: OpenRun = { run: 7, kind: 'build', repo: 'kata', waiting: true };
const choice: RunChoice = { run: 7, kind: 'build', repo: 'kata', waiting: true, label: 'kata', action: 'Answer', open };
const row = (change: string, over: Partial<StripRow> = {}): StripRow => ({
  id: `/w|kata|${change}`,
  workspaceId: 'w1',
  system: 'kata',
  change,
  name: change,
  state: 'needs an answer',
  tone: 'awaiting',
  text: 'Which branch?',
  direct: choice,
  choices: [],
  title: 'needs an answer: Which branch?',
  ...over,
});
const text = (c: ParentNode) => c.textContent!.replace(/\s+/g, ' ').trim();

// The strip is presentational: it draws the rows it is given and says which one was picked, with no transport, router or store.
describe('RunningStrip', () => {
  it('draws the rows it is given and the All running label, with nothing provided', async () => {
    const rows = [row('c-one'), row('c-two', { state: 'working', tone: 'running', text: 'build in kata', direct: null })];
    const { container } = await render(RunningStrip, { shown: rows, all: rows, allLabel: 'All running (2)' });
    const entries = Array.from(container.querySelectorAll('[data-testid="running-entry"]'));
    expect(entries.map((e) => e.getAttribute('data-change'))).toEqual(['c-one', 'c-two']);
    expect(text(entries[0])).toContain('needs an answer');
    expect(text(container)).toContain('All running (2)');
  });

  it('draws nothing when no change is running', async () => {
    const { container } = await render(RunningStrip, { shown: [], all: [], allLabel: 'All running (0)' });
    expect(container.querySelector('.k-running')).toBeNull();
  });

  it('picking an entry that opens one run says which row and run were picked', async () => {
    const r = row('c-one');
    const { container, fixture } = await render(RunningStrip, { shown: [r], all: [r], allLabel: 'All running (1)' });
    const picked: StripPick[] = [];
    fixture.componentInstance.pick.subscribe((p) => picked.push(p));
    container.querySelector<HTMLButtonElement>('[data-testid="running-entry"]')!.click();
    expect(picked).toEqual([{ row: r, choice }]);
  });
});
