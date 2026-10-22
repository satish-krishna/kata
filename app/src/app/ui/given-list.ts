import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronRight, lucideLock } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { itemKindName, itemSourceLabel, markLabel, type KindGroup, type PresetRow } from '../lib/given';

export type GivenToggle = { key: string; off: boolean };

/* What a run is given, by kind and then by source. The same list shows a preview (switches on) and a finished run
 * (readonly, with a status label per row). A plugin's own hooks, skills and tool servers sit under it and follow it. */
@Component({
  selector: 'app-given-list',
  imports: [NgTemplateOutlet, NgIcon, HlmButtonImports, HlmSwitchImports],
  providers: [provideIcons({ lucideChevronDown, lucideChevronRight, lucideLock })],
  templateUrl: './given-list.html',
  styleUrl: './given-list.css',
})
export class GivenList {
  readonly groups = input.required<KindGroup[]>();
  readonly readonly = input<boolean>(false);
  /** Extra text at the end of a row (null for none); the preview passes nothing. */
  readonly statusLabel = input<((row: PresetRow) => string | null) | null>(null);
  readonly toggle = output<GivenToggle>();

  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly sourceLabel = itemSourceLabel;
  protected readonly kindName = itemKindName;
  protected readonly markLabel = markLabel;

  protected switchable(row: PresetRow): boolean {
    return row.locked === null && row.item.brought_by === null;
  }

  /** A lock worth showing: a follower is held by its plugin, which the row says by being off with it. */
  protected lockText(row: PresetRow): string | null {
    return row.locked && row.locked.kind !== 'follows-plugin' ? row.locked.text : null;
  }

  protected status(row: PresetRow): string | null {
    return this.statusLabel()?.(row) ?? null;
  }

  protected isCollapsed(key: string): boolean {
    return this.collapsed().has(key);
  }

  protected toggleCollapsed(key: string): void {
    const next = new Set(this.collapsed());
    if (!next.delete(key)) next.add(key);
    this.collapsed.set(next);
  }
}
