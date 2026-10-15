import { Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolderOpen, lucidePackage, lucidePlay } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';

// A run's kata can be deleted (or never saved) while its history entry lives
// on, so all three actions need the kata to still exist. When it doesn't, the
// buttons disable and a title explains why rather than failing silently.
const MISSING_KATA_HINT =
  "This run's kata is not in the library — save or recreate it to re-run, open in compose, or export.";

@Component({
  selector: 'app-detail-actions',
  host: { class: 'contents' },
  imports: [NgIcon, HlmButtonImports],
  providers: [provideIcons({ lucideFolderOpen, lucidePackage, lucidePlay })],
  // The hint lives on the container, not the buttons: a disabled <button> doesn't
  // fire pointer events, so a title on it never shows on hover.
  template: `
    <div class="wb-detail__actions" [attr.title]="hint()">
      <button hlmBtn variant="primary" size="sm" type="button" [disabled]="!kataSaved()" (click)="reRun.emit()">
        <ng-icon name="lucidePlay" size="13" />Re-run
      </button>
      <button hlmBtn variant="secondary" size="sm" type="button" [disabled]="!kataSaved()" (click)="openInCompose.emit()">
        <ng-icon name="lucideFolderOpen" size="14" />Open in compose
      </button>
      <button hlmBtn variant="ghost" size="sm" type="button" [disabled]="!kataSaved()" (click)="exportBundle.emit()">
        <ng-icon name="lucidePackage" size="14" />Export bundle
      </button>
    </div>
  `,
})
export class DetailActions {
  readonly kataSaved = input.required<boolean>();
  readonly reRun = output<void>();
  readonly openInCompose = output<void>();
  readonly exportBundle = output<void>();

  protected readonly hint = computed(() => (this.kataSaved() ? null : MISSING_KATA_HINT));
}
