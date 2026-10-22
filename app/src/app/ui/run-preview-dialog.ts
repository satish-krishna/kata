import { Component, input, output } from '@angular/core';
import type { KindGroup } from '../lib/given';
import type { GivenToggle } from './given-list';

export type PreviewSettingRow = { label: string; value: string; source: string };
export type PreviewEnvRow = { name: string; source: string; apiKey?: boolean };
export type PreviewSection = { title: string; groups: KindGroup[] };

@Component({ selector: 'app-run-preview-dialog', templateUrl: './run-preview-dialog.html' })
export class RunPreviewDialog {
  readonly open = input.required<boolean>();
  readonly title = input.required<string>();
  readonly settings = input.required<PreviewSettingRow[]>();
  readonly safetyRules = input<string[] | null>(null);
  readonly env = input<PreviewEnvRow[]>([]);
  readonly groups = input<KindGroup[]>([]);
  readonly sections = input<PreviewSection[] | null>(null);
  readonly warnings = input<string[]>([]);
  readonly busy = input<boolean>(false);
  readonly toggle = output<GivenToggle>();
  readonly start = output<void>();
  readonly cancel = output<void>();
}
