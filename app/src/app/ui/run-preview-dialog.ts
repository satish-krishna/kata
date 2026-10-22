import { Component, input, output } from '@angular/core';
import type { BrnDialogState } from '@spartan-ng/brain/dialog';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { KindGroup } from '../lib/given';
import { GivenList, type GivenToggle } from './given-list';

export type PreviewSettingRow = { label: string; value: string; source: string };
export type PreviewEnvRow = { name: string; source: string; apiKey?: boolean };
export type PreviewSection = { title: string; groups: KindGroup[] };

/* The look at a run before it starts: the settings it will run with (read-only, each with its source), the names of the
 * environment variables it sees, and every item it will be given, which the engineer can switch off. A build passes
 * `sections` (one per repository) and projects its time-limit form into the top slot. */
@Component({
  selector: 'app-run-preview-dialog',
  host: { class: 'contents' },
  imports: [HlmDialogImports, HlmButtonImports, GivenList],
  templateUrl: './run-preview-dialog.html',
  styleUrl: './run-preview-dialog.css',
})
export class RunPreviewDialog {
  readonly open = input.required<boolean>();
  readonly title = input.required<string>();
  readonly settings = input.required<PreviewSettingRow[]>();
  /** The build's safety rules; null for a run that has none. */
  readonly safetyRules = input<string[] | null>(null);
  readonly env = input<PreviewEnvRow[]>([]);
  readonly groups = input<KindGroup[]>([]);
  /** A build's items, one section per repository; when set, `groups` is not shown. */
  readonly sections = input<PreviewSection[] | null>(null);
  readonly warnings = input<string[]>([]);
  readonly busy = input<boolean>(false);

  readonly toggle = output<GivenToggle>();
  readonly start = output<void>();
  readonly cancel = output<void>();

  /** Escape and a backdrop click close the overlay from inside; surface that as cancel. */
  protected onState(state: BrnDialogState): void {
    if (state === 'closed' && this.open()) this.cancel.emit();
  }
}
