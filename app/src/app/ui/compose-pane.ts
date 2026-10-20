import { Component, computed, effect, input, linkedSignal, model, output, signal, untracked } from '@angular/core';
import { FormField, type FieldTree } from '@angular/forms/signals';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolder, lucideTriangleAlert } from '@ng-icons/lucide';
import { HlmAlertImports } from '@spartan-ng/helm/alert';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSelectImports } from '@spartan-ng/helm/select';
import { HlmTextareaImports } from '@spartan-ng/helm/textarea';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { RunSpec } from '@bindings/RunSpec';
import { appendContext } from '../lib/katas';
import { modelChoiceFor, modelIdForChoice, type ModelChoice } from '../lib/spec';
import { Field } from './field';
import { KitChecklist } from './kit-checklist';
import { NullableNumber } from './nullable-number';
import { PromptDialog } from './prompt-dialog';
import { Segmented } from './segmented';

const opts = <T extends string>(...values: T[]) => values.map((value) => ({ value, label: value as string }));

type TextKey = 'description' | 'context' | 'system_prompt' | 'token_env';

/** The nullable text fields. The generated types make them `string | null`, which Signal Forms
 *  will not bind to a text control, so they write through the root like the other optional keys. */
const TEXT_SETTERS: Record<TextKey, (s: RunSpec, v: string) => void> = {
  description: (s, v) => (s.description = v),
  context: (s, v) => (s.context = v),
  system_prompt: (s, v) => (s.identity.system_prompt = v),
  token_env: (s, v) => (s.auth.token_env = v),
};

type PermissionMode = RunSpec['permissions']['mode'];

// In full mode claude uses the logged-in session, so a still-set token_env is
// ignored. Surface that at compose time so the hidden token field isn't a mystery.
const ROOM_HINT = 'bare = the empty room (curated kit only). full = your real claude config, plugins, and login.';

@Component({
  selector: 'app-compose-pane',
  host: { class: 'wb-compose' },
  imports: [
    NgIcon,
    FormField,
    HlmAlertImports,
    HlmButtonImports,
    HlmInput,
    HlmTextareaImports,
    HlmSelectImports,
    Field,
    Segmented,
    KitChecklist,
    NullableNumber,
    PromptDialog,
  ],
  providers: [provideIcons({ lucideFolder, lucideTriangleAlert })],
  templateUrl: './compose-pane.html',
})
export class ComposePane {
  /** The Signal Forms tree over the draft run-spec, owned by the WorkbenchViewModel. */
  readonly form = input.required<FieldTree<RunSpec>>();
  readonly catalog = input.required<CatalogEntry[]>();
  readonly presets = input.required<Preset[]>();
  readonly pickWorkdir = output<void>();
  readonly savePreset = output<{ name: string; body: string }>();

  protected readonly IDENTITY_MODES = opts('append', 'replace');
  protected readonly MODEL_CHOICES = opts<ModelChoice>('default', 'opus', 'sonnet', 'haiku', 'custom');
  protected readonly ROOMS = opts('bare', 'full');
  protected readonly ISOLATIONS = opts('none', 'worktree');
  protected readonly INTERACTIVE = opts('off', 'on');
  protected readonly PERMISSION_MODES = opts<PermissionMode>('bypass', 'prompt', 'auto');
  protected readonly UNMATCHED = opts('ask', 'deny', 'allow');
  protected readonly ALLOW_PLACEHOLDER = 'Read\nGrep\nBash(git *)';

  protected readonly spec = computed(() => this.form()().value());
  protected readonly contextText = computed(() => this.spec().context ?? '');
  protected readonly kitCount = computed(() => this.spec().skills.length + Object.keys(this.spec().plugins).length);
  protected readonly roomHint = computed(() => {
    const a = this.spec().auth;
    return !a.bare && a.token_env?.trim() ? `${ROOM_HINT} (token_env is set but ignored in full mode.)` : ROOM_HINT;
  });

  /** Whether the save-as-preset name prompt is open. The Workbench owns it so a Ctrl+Enter pressed in the prompt cannot start a run. */
  readonly naming = model(false);
  /** The preset picker's controlled value. A pick lands here, is applied by the effect below, and is
   *  reset to null so the one select instance (and its focus) shows the placeholder again. */
  protected readonly pickedPreset = signal<string | null>(null);

  constructor() {
    effect(() => {
      const name = this.pickedPreset();
      if (name === null) return;
      untracked(() => this.applyPreset(name));
      // Reset after this change-detection pass: the select must first see the pick, and a same-pass
      // reset to null would be coalesced away and leave the pick showing.
      queueMicrotask(() => this.pickedPreset.set(null));
    });
  }

  // Model selection (resolution logic + rationale live in lib/spec). customMode keeps the
  // free-text field open while the id is still blank: an empty custom id is stored as null
  // so the engine omits --model rather than passing `--model ""`, which is why a blank id
  // alone can't imply "custom". A concrete id (a loaded kata, an alias click, typed custom
  // text) re-derives the flag so it can't leak across specs; a blank id leaves it alone so
  // clearing the custom field stays in custom mode mid-edit.
  protected readonly customMode = linkedSignal<string | null | undefined, boolean>({
    source: () => this.spec().model.id,
    computation: (id, prev) => (id && id.trim() ? modelChoiceFor(id) === 'custom' : (prev?.value ?? false)),
  });
  protected readonly modelChoice = computed<ModelChoice>(() =>
    this.customMode() ? 'custom' : modelChoiceFor(this.spec().model.id),
  );

  private applyPreset(name: string): void {
    const p = this.presets().find((x) => x.name === name);
    if (p) this.patch((s) => (s.context = appendContext(s.context, p.body)));
  }

  protected onSaveAsPreset(): void {
    if (this.contextText().trim() === '') return;
    this.naming.set(true);
  }

  protected onSavePreset(name: string): void {
    this.naming.set(false);
    this.savePreset.emit({ name, body: this.contextText() });
  }

  protected onModelChoice(choice: ModelChoice): void {
    this.customMode.set(choice === 'custom');
    this.patch((s) => (s.model.id = modelIdForChoice(choice)));
  }

  protected onCustomId(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.patch((s) => (s.model.id = v === '' ? null : v));
  }

  // Permission rules edit as one-per-line text; blank lines are dropped so a
  // trailing newline never becomes an empty rule the engine would reject.
  protected rulesText(rules: string[] | undefined): string {
    return (rules ?? []).join('\n');
  }

  protected setRules(which: 'allow' | 'deny' | 'ask', e: Event): void {
    const rules = (e.target as HTMLTextAreaElement).value
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r !== '');
    this.patch((s) => (s.permissions[which] = rules));
  }

  // Rules are only consulted under prompt and auto modes and the engine rejects a spec
  // that carries them under bypass. The editors are hidden there, so keeping the values
  // would produce a validation error naming a field the operator cannot see: drop them
  // with the mode instead. Do not swap this back to a plain field binding; the
  // clear-on-bypass side effect is the whole point.
  protected onPermissionMode(mode: PermissionMode): void {
    this.patch((s) => {
      s.permissions.mode = mode;
      if (mode === 'bypass') {
        s.permissions.allow = [];
        s.permissions.deny = [];
        s.permissions.ask = [];
      }
    });
  }

  protected setText(key: TextKey, e: Event): void {
    const v = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.patch((s) => TEXT_SETTERS[key](s, v));
  }

  protected setLeash(key: 'max_turns' | 'timeout_secs' | 'max_budget_usd', v: number | null | undefined): void {
    this.patch((s) => (s.leash[key] = v ?? null));
  }

  protected setAnswerTimeout(v: number | null | undefined): void {
    this.patch((s) => (s.interactive.answer_timeout_secs = v ?? null));
  }

  /** Keys the generated RunSpec types mark optional have no field child in the tree, so every
   *  write to one goes through the root: edit a clone, then set it. Never mutate the signal's value. */
  private patch(mutate: (s: RunSpec) => void): void {
    const next = structuredClone(this.spec());
    mutate(next);
    this.form()().value.set(next);
  }

  protected enableInteractive(): void {
    this.form().interactive.enabled().value.set(true);
  }
}
