import { Component, computed, input, output, signal } from '@angular/core';
import type { StartChecks } from '@bindings/StartChecks';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { AcceptRefusal } from '../sdlc/build/build-page.view-model';

/** One failed check, or the step that stopped the start, as the panel lists it. */
interface FailureRow {
  name: string;
  badge: { tone: 'error' | 'warning'; word: string };
  /** `exit 101 · 3c504eb`; empty when the row has no exit code. */
  facts: string;
  why: string;
  output: string;
  lines: number;
  canAccept: boolean;
}

const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const wordFor = (n: number): string => WORDS[n] ?? String(n);
const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length);

/* Why the build did not start, shown once on the Build tab: a failure on the base that a check does not name, a check that could not
 * run, or a step that failed. The words about what happened and which check may be accepted come from the backend's answer; this
 * arranges them. The output is interpolated text, never HTML. Presentational: accepting and copying are the host's. */
@Component({
  selector: 'app-build-failure-panel',
  imports: [HlmButtonImports],
  templateUrl: './build-failure-panel.html',
  styleUrl: './build-failure-panel.css',
})
export class BuildFailurePanel {
  readonly start = input.required<StartChecks>();
  /** The workflow's reasons for refusing the last acceptance, shown under the check they were for. */
  readonly refusal = input<AcceptRefusal | null>(null);
  /** The check the engineer asked to accept. */
  readonly accept = output<string>();
  /** The output text the engineer asked to copy. */
  readonly copy = output<string>();

  /** The rows whose output is open. */
  protected readonly open = signal<ReadonlySet<string>>(new Set());

  protected readonly kind = computed(() => this.start().shown.kind);
  protected readonly settled = computed(() => this.kind() === 'allAccepted');

  protected readonly rows = computed<FailureRow[]>(() => {
    const s = this.start();
    if (s.shown.kind === 'otherReason') {
      const shown = s.shown;
      return [{ name: shown.step ?? 'start', badge: { tone: 'error', word: 'stopped the start' }, facts: '', why: '', output: shown.output, lines: lineCount(shown.output), canAccept: false }];
    }
    return s.checks
      .filter((c) => c.state === 'failed')
      .map((c): FailureRow => {
        const unsaid = c.canAccept || c.accepted;
        return {
          name: c.check,
          badge: c.accepted ? { tone: 'warning', word: 'accepted for this build' } : { tone: 'error', word: 'failed on the base' },
          facts: `${c.exitCode === null ? '' : `exit ${c.exitCode} · `}${s.base}`,
          why: c.accepted
            ? `It still runs at finish and its result is shown, but it will not block this build while the base stays at ${s.base}.`
            : unsaid
              ? 'It wrote no list of what failed, so the workflow cannot compare the base with this build.'
              : 'It names what failed, so only new failures block this build.',
          output: c.output,
          lines: c.lineCount,
          canAccept: c.canAccept && !c.accepted,
        };
      });
  });

  /** How many failed checks do not say what failed, accepted or not. */
  private readonly unsaid = computed(() => this.start().checks.filter((c) => c.state === 'failed' && (c.canAccept || c.accepted)).length);

  protected readonly title = computed(() => {
    const s = this.start();
    if (s.shown.kind === 'otherReason') return s.shown.reason;
    if (s.shown.kind === 'allAccepted') return 'Every check that fails on the base is accepted for this build';
    const n = this.unsaid();
    if (n === 0) return 'The base fails its checks';
    return n === 1 ? '1 check fails on the base and does not say what failed' : `${n} of ${s.checks.length} checks fail on the base and do not say what failed`;
  });

  protected readonly hint = computed(() =>
    this.start().setupHint && this.kind() === 'baseFailure'
      ? `${wordFor(this.unsaid())} failed at once. That usually means the setup is broken rather than the code, for example missing packages or a tool that is not installed. Read one output first, before accepting any.`
      : null,
  );

  protected readonly passedNames = computed(() => this.start().checks.filter((c) => c.state === 'passed').map((c) => c.check));
  protected readonly passedWords = computed(() => {
    const n = this.start().passed;
    return `${n} other ${n === 1 ? 'check' : 'checks'} passed on the base`;
  });

  protected refusalFor(name: string): string[] {
    const r = this.refusal();
    return r !== null && r.check === name ? r.problems : [];
  }

  protected isOpen(name: string): boolean {
    return this.open().has(name);
  }

  protected toggle(name: string): void {
    this.open.update((was) => {
      const next = new Set(was);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }
}
