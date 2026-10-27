import { TestBed } from '@angular/core/testing';
import { PROGRESS_NAMES, PROGRESS_STEPS, PROGRESS_STEP_IDS, type ProgressStepId } from '../../lib/progress-steps';
import { ProgressStore } from './progress.store';

/* The plain verb each step's lines must contain, written out here so a line cannot drift from what the step does. */
const VERB: Record<ProgressStepId, string> = {
  'reading-stages': 'reading',
  'reading-change': 'reading',
  'reading-diff': 'reading',
  'preparing-build': 'checking',
  'running-checks': 'running',
  'pushing': 'pushing',
  'opening-prs': 'opening',
};

describe('ProgressStore', () => {
  let store: ProgressStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    TestBed.configureTestingModule({});
    store = TestBed.inject(ProgressStore);
  });

  afterEach(() => {
    store.end();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const shown = () => store.view()();

  it('follows the display table', () => {
    const first = PROGRESS_STEPS['reading-change'].lines[0];
    // Row 1: running, under 400 ms: nothing.
    store.begin('reading-change', 'Reading the change');
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(399);
    expect(shown()).toBeNull();
    // Row 2: running, 400 ms up to the threshold (max(3 x 1 s, 10 s) = 10 s): the playful line and the plain label.
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual({ line: first, label: 'Reading the change', long: false });
    vi.advanceTimersByTime(9_599);
    expect(shown()?.long).toBe(false);
    // Row 3: running, at or past the threshold: the long notice in place of the playful line, and the plain label.
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual({ line: 'Reading the change is taking longer than usual (10 s)', label: 'Reading the change', long: true });
    // Row 4: ended: nothing.
    store.end();
    expect(shown()).toBeNull();
    // Row 5: failed, at any elapsed time: nothing.
    store.begin('reading-change', 'Reading the change');
    vi.advanceTimersByTime(2_000);
    expect(shown()).not.toBeNull();
    store.fail();
    expect(shown()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(shown()).toBeNull();
  });

  it('each step names what it does', () => {
    for (const id of PROGRESS_STEP_IDS) {
      const { lines } = PROGRESS_STEPS[id];
      expect(lines.length, id).toBeGreaterThanOrEqual(4);
      expect(lines.length, id).toBeLessThanOrEqual(6);
      expect(PROGRESS_NAMES[id], id).not.toBe('');
      for (const line of lines) {
        expect(line.toLowerCase(), line).toContain(VERB[id]);
        expect(line, line).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(line.endsWith('…'), line).toBe(true);
        expect(line[0], line).toBe(line[0].toUpperCase());
      }
    }
  });

  it('rotates the playful line and keeps the plain label', () => {
    const { lines } = PROGRESS_STEPS['reading-stages'];
    store.begin('reading-stages', '1 of 12 changes read');
    vi.advanceTimersByTime(1_000);
    expect(shown()).toEqual({ line: lines[0], label: '1 of 12 changes read', long: false });
    vi.advanceTimersByTime(4_000);
    expect(shown()?.line).toBe(lines[1]);
    store.update('5 of 12 changes read');
    expect(shown()).toEqual({ line: lines[1], label: '5 of 12 changes read', long: false });
    vi.advanceTimersByTime(5_000);
    expect(shown()).toEqual({ line: lines[2], label: '5 of 12 changes read', long: false });
  });

  it('starts the rotation from a random line', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { lines } = PROGRESS_STEPS['reading-stages'];
    store.begin('reading-stages', 'x');
    vi.advanceTimersByTime(500);
    expect(shown()).not.toBeNull();
    expect(shown()?.line).toBe(lines[lines.length - 1]);
    vi.advanceTimersByTime(4_500);
    expect(shown()?.line).toBe(lines[0]);
  });

  it('a failure clears the line before the error shows', async () => {
    store.begin('pushing', 'Pushing change/x in kata');
    vi.advanceTimersByTime(1_000);
    expect(shown()).not.toBeNull();
    let atError: unknown = 'unset';
    const run = async () => {
      try {
        throw new Error('push refused');
      } catch (e) {
        store.fail();
        atError = shown();
        throw e;
      }
    };
    await expect(run()).rejects.toThrow('push refused');
    expect(atError).toBeNull();
  });

  it('says plainly when a step runs long', () => {
    // 3 x usual, and never under 10 s.
    store.begin('preparing-build', 'Checking the repositories');
    vi.advanceTimersByTime(14_999);
    expect(shown()?.long).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual({ line: 'Preparing the build is taking longer than usual (15 s)', label: 'Checking the repositories', long: true });
    store.end();

    store.begin('reading-diff', 'Reading the changes in kata');
    vi.advanceTimersByTime(9_999);
    expect(shown()?.long).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shown()?.line).toBe('Reading what changed is taking longer than usual (10 s)');
    vi.advanceTimersByTime(30_000);
    expect(shown()?.line).toBe('Reading what changed is taking longer than usual (40 s)');
  });

  it('keeps one entry per owner', () => {
    store.begin('reading-change', 'Reading the change', 'page');
    store.begin('running-checks', 'Running the checks in kata', 'lock');
    vi.advanceTimersByTime(500);
    expect(store.view('page')()?.label).toBe('Reading the change');
    expect(store.view('lock')()?.label).toBe('Running the checks in kata');
    store.end('lock');
    expect(store.view('lock')()).toBeNull();
    expect(store.view('page')()).not.toBeNull();
    store.end('page');
  });

  it('a new begin replaces the entry of its owner and restarts the clock', () => {
    store.begin('pushing', 'Pushing change/x in kata', 'lock');
    vi.advanceTimersByTime(2_000);
    store.begin('opening-prs', 'Opening a pull request in kata', 'lock');
    expect(store.view('lock')()).toBeNull();
    vi.advanceTimersByTime(400);
    expect(store.view('lock')()?.label).toBe('Opening a pull request in kata');
    store.end('lock');
  });
});
