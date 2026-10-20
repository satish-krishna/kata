import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, viewChild } from '@angular/core';
import type { FilePair } from '@bindings/FilePair';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideChevronUp } from '@ng-icons/lucide';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { nextChangeLine, previousChangeLine } from './change-navigation';
import { KATA_THEME, defineKataTheme } from './kata-theme';
import { monaco, type MonacoApi } from './monaco.loader';

/**
 * The one Monaco diff editor of the Changes view. Read-only, folds unchanged regions, and
 * swaps in a fresh pair of models for each file, disposing the previous pair once the editor
 * no longer holds it. The file pair and the layout come in as inputs; the parent decides
 * side by side or inline. `updateModified` replaces the new side's text in place for a refresh.
 */
@Component({
  selector: 'app-diff-editor',
  imports: [NgIcon, HlmButtonImports],
  providers: [provideIcons({ lucideChevronDown, lucideChevronUp })],
  templateUrl: './diff-editor.html',
  styleUrl: './diff-editor.css',
})
export class DiffEditor {
  readonly pair = input<FilePair | null>(null);
  readonly sideBySide = input(true);
  /** Fresh text for the new side of the current file, for a refresh that keeps scroll and expanded regions. Clear it when the file changes. */
  readonly modifiedText = input<string | null>(null);

  protected readonly binary = computed(() => this.pair()?.binary === true);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private api?: MonacoApi;
  private editor?: Monaco.editor.IStandaloneDiffEditor;
  private models: Monaco.editor.ITextModel[] = [];
  private destroyed = false;

  constructor() {
    afterNextRender(() => void this.create());
    // Each effect reads its signal before touching the editor. The editor loads
    // asynchronously, so a first run that short-circuited on a missing editor would read
    // no signal, track nothing, and never run again.
    effect(() => this.show(this.pair()));
    effect(() => {
      const renderSideBySide = this.sideBySide();
      this.editor?.updateOptions({ renderSideBySide });
    });
    effect(() => {
      const text = this.modifiedText();
      if (text !== null) this.updateModified(text);
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      window.removeEventListener('resize', this.relayout);
      this.editor?.dispose();
      this.disposeModels(this.models);
      this.models = [];
    });
  }

  nextChange(): void {
    this.revealChange(nextChangeLine);
  }

  previousChange(): void {
    this.revealChange(previousChangeLine);
  }

  /** Replaces the new side's text only, so scroll position and expanded regions stay. */
  updateModified(text: string): void {
    const modified = this.models[1];
    modified?.setValue(text);
  }

  /** automaticLayout watches the pane; this also covers a window resize that the pane observer lags behind. */
  private readonly relayout = (): void => this.editor?.layout();

  private async create(): Promise<void> {
    const api = await monaco.load();
    if (this.destroyed) return;
    this.api = api;
    defineKataTheme(api, getComputedStyle(document.documentElement));
    this.editor = api.editor.createDiffEditor(this.host().nativeElement, {
      theme: KATA_THEME,
      readOnly: true,
      originalEditable: false,
      hideUnchangedRegions: { enabled: true },
      renderSideBySide: this.sideBySide(),
      useInlineViewWhenSpaceIsLimited: false,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      mouseWheelZoom: false,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || "'IBM Plex Mono', monospace",
      fontSize: 13,
    });
    window.addEventListener('resize', this.relayout);
    this.show(this.pair());
    const text = this.modifiedText();
    if (text !== null) this.updateModified(text);
  }

  /** Swaps in models for `pair`. The old models are disposed only after the editor lets go of them. */
  private show(pair: FilePair | null): void {
    const { api, editor } = this;
    if (!api || !editor) return;
    const previous = this.models;
    if (pair && !pair.binary) {
      const original = api.editor.createModel(pair.original, pair.languageHint);
      const modified = api.editor.createModel(pair.modified, pair.languageHint);
      editor.setModel({ original, modified });
      this.models = [original, modified];
    } else {
      editor.setModel(null);
      this.models = [];
    }
    this.disposeModels(previous);
  }

  private revealChange(pick: (changes: Monaco.editor.ILineChange[], line: number) => number | null): void {
    const editor = this.editor;
    if (!editor) return;
    const modified = editor.getModifiedEditor();
    const line = pick(editor.getLineChanges() ?? [], modified.getPosition()?.lineNumber ?? 0);
    if (line === null) return;
    modified.setPosition({ lineNumber: line, column: 1 });
    modified.revealLineInCenter(line);
    modified.focus();
  }

  private disposeModels(models: Monaco.editor.ITextModel[]): void {
    for (const model of models) model.dispose();
  }
}
