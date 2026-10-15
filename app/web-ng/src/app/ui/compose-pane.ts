import { Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { FormField, type FieldTree } from '@angular/forms/signals';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideFolder, lucideTriangleAlert } from '@ng-icons/lucide';
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
  template: `
    <app-field label="Description" key="description">
      <input hlmInput placeholder="One line — what this form is for" [value]="spec().description ?? ''" (input)="setText('description', $event)" />
    </app-field>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__title">Task</span>
        <span class="wb-section__sub">the job, verbatim</span>
      </div>
      <app-field label="Task" key="task">
        <textarea hlmTextarea rows="3" [formField]="form().task"></textarea>
      </app-field>
      <app-field label="Context" key="context" hint="Appended after the task.">
        <textarea hlmTextarea rows="2" [value]="contextText()" (input)="setText('context', $event)"></textarea>
        <div class="wb-presets">
          @for (k of [pickerKey()]; track k) {
            <hlm-select [value]="''" (valueChange)="onPickPreset($event)">
              <hlm-select-trigger aria-label="Insert context preset">
                <hlm-select-value placeholder="Insert preset…" />
              </hlm-select-trigger>
              <hlm-select-content *hlmSelectPortal>
                @for (p of presets(); track p.name) {
                  <hlm-select-item [value]="p.name">{{ p.name }}</hlm-select-item>
                }
              </hlm-select-content>
            </hlm-select>
          }
          <button hlmBtn variant="ghost" size="sm" type="button" [disabled]="!contextText().trim()" (click)="onSaveAsPreset()">
            Save as preset
          </button>
        </div>
      </app-field>
      <app-field label="Workdir" key="workdir" hint="cwd for claude -p; the agent's file tools resolve here.">
        <div class="wb-picker">
          <input hlmInput variant="mono" [formField]="form().workdir" />
          <button hlmBtn variant="secondary" type="button" (click)="pickWorkdir.emit()">
            <ng-icon name="lucideFolder" size="16" />Browse…
          </button>
        </div>
      </app-field>
    </section>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__num">02 · TELL IT WHAT IT IS</span>
        <span class="wb-section__title">Identity</span>
      </div>
      <app-field label="System prompt" key="identity.system_prompt" hint="Empty = stay the default coding assistant.">
        <textarea hlmTextarea rows="2" [value]="spec().identity.system_prompt ?? ''" (input)="setText('system_prompt', $event)"></textarea>
      </app-field>
      <app-field label="Mode" key="identity.mode">
        <app-segmented
          [options]="IDENTITY_MODES"
          [value]="spec().identity.mode"
          (valueChange)="form().identity.mode().value.set($event)"
          ariaLabel="Identity mode"
        />
      </app-field>
    </section>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__num">03 · THE CURATED KIT</span>
        <span class="wb-section__title">Kit</span>
        <span class="wb-section__sub">{{ kitCount() }} selected</span>
      </div>
      <app-kit-checklist [spec]="spec()" [entries]="catalog()" (specChange)="form()().value.set($event)" />
    </section>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__title">Model</span>
      </div>
      <app-field
        label="Model"
        key="model.id"
        hint="opus / sonnet / haiku are aliases claude resolves to its current model for that tier at run time. default omits --model."
      >
        <app-segmented [options]="MODEL_CHOICES" [value]="modelChoice()" ariaLabel="Model" (valueChange)="onModelChoice($event)" />
      </app-field>
      @if (modelChoice() === 'custom') {
        <app-field label="Model id" key="model.id" hint="Pin an exact model id, e.g. claude-opus-4-8.">
          <input
            hlmInput
            variant="mono"
            placeholder="claude-opus-4-8"
            spellcheck="false"
            [value]="spec().model.id ?? ''"
            (input)="onCustomId($event)"
          />
        </app-field>
      }
    </section>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__title">Environment</span>
        <span class="wb-section__sub">the room claude runs in</span>
      </div>
      <app-field label="Room" key="auth.bare" [hint]="roomHint()">
        <app-segmented
          [options]="ROOMS"
          [value]="spec().auth.bare ? 'bare' : 'full'"
          (valueChange)="form().auth.bare().value.set($event === 'bare')"
          ariaLabel="Environment"
        />
      </app-field>
      @if (spec().auth.bare) {
        <app-field
          label="Token env var"
          key="auth.token_env"
          hint="Name of an env var holding your API key — not the key itself. Empty = use ambient credentials (claude login)."
        >
          <input hlmInput variant="mono" placeholder="ANTHROPIC_API_KEY"
            [value]="spec().auth.token_env ?? ''"
            (input)="setText('token_env', $event)"
          />
        </app-field>
      }
    </section>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__num">04 · THE LEASH</span>
        <span class="wb-section__title">Leash</span>
        <span class="wb-section__sub">cap · contain · observe</span>
      </div>
      <div class="wb-grid-2">
        <app-field label="Max turns" key="max_turns" hint="empty = unlimited · engine cap → exit 125 when set">
          <input
            hlmInput
            type="number"
            min="1"
            step="1"
            placeholder="unlimited"
            [nullableNumber]="spec().leash.max_turns"
            (nullableNumberChange)="setLeash('max_turns', $event)"
            integer
            [floor]="1"
          />
        </app-field>
        <app-field label="Timeout (secs)" key="timeout_secs" hint="Wall-clock kill → exit 124.">
          <input hlmInput type="number" min="0" step="1" placeholder="(none)" [nullableNumber]="spec().leash.timeout_secs" (nullableNumberChange)="setLeash('timeout_secs', $event)" integer />
        </app-field>
        <app-field
          label="Max budget (USD)"
          key="max_budget_usd"
          hint="Claude-native ceiling → exit 122 (approximate; checked at turn boundaries)."
        >
          <input
            hlmInput
            type="number"
            min="0"
            step="0.01"
            placeholder="(none)"
            [nullableNumber]="spec().leash.max_budget_usd"
            (nullableNumberChange)="setLeash('max_budget_usd', $event)"
            exclusive
          />
        </app-field>
      </div>
      <app-field
        label="Isolation"
        key="leash.isolation"
        hint="worktree contains writes in an ephemeral git worktree (reviewable as a diff)."
      >
        <app-segmented
          [options]="ISOLATIONS"
          [value]="spec().leash.isolation"
          (valueChange)="form().leash.isolation().value.set($event)"
          ariaLabel="Isolation"
        />
      </app-field>
    </section>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__title">Interactive</span>
        <span class="wb-section__sub">pause for operator input</span>
      </div>
      <!-- Questions reach the operator on every run: ask_user is always wired, so
           the timeout applies whatever this toggle says. The toggle only lets
           permission checks pause on the operator too. -->
      <app-field
        label="Mode"
        key="interactive.enabled"
        hint="claude can ask you a question on any run; on also lets permission checks (ask rules, unmatched = ask) pause on you."
      >
        <app-segmented
          [options]="INTERACTIVE"
          [value]="spec().interactive.enabled ? 'on' : 'off'"
          (valueChange)="form().interactive.enabled().value.set($event === 'on')"
          ariaLabel="Interactive mode"
        />
      </app-field>
      <app-field
        label="Answer timeout"
        key="answer_timeout_secs"
        hint="seconds to wait on your answer, on any run; blank = wait indefinitely"
      >
        <input
          hlmInput
          type="number"
          min="0"
          step="1"
          placeholder="(none)"
          [nullableNumber]="spec().interactive.answer_timeout_secs"
          (nullableNumberChange)="setAnswerTimeout($event)"
          integer
        />
      </app-field>
    </section>

    <section class="wb-section">
      <div class="wb-section__head">
        <span class="wb-section__title">Permissions</span>
        <span class="wb-section__sub">how claude's checks are answered</span>
      </div>
      <app-field
        label="Mode"
        key="permissions.mode"
        hint="bypass passes --dangerously-skip-permissions; prompt writes allow/deny into claude's own settings and claude enforces them — the route when managed settings forbid bypass; auto uses claude's built-in permission classifier."
      >
        <app-segmented
          [options]="PERMISSION_MODES"
          [value]="spec().permissions.mode"
          (valueChange)="onPermissionMode($event)"
          ariaLabel="Permission mode"
        />
      </app-field>
      @if (spec().permissions.mode === 'prompt') {
        <app-field
          label="Unmatched"
          key="permissions.unmatched"
          hint="what happens to a call claude's settings leave unresolved. ask needs interactive on; deny refuses it, but allow alone isn't a full tool surface — claude has no catch-all deny."
        >
          <app-segmented
            [options]="UNMATCHED"
            [value]="spec().permissions.unmatched"
            (valueChange)="form().permissions.unmatched().value.set($event)"
            ariaLabel="Unmatched policy"
          />
        </app-field>
        @if (spec().permissions.unmatched === 'ask' && !spec().interactive.enabled) {
          <div class="wb-banner wb-banner--error" role="alert">
            <ng-icon name="lucideTriangleAlert" size="15" />
            <div class="wb-banner__list">
              <span><code>permissions.unmatched = "ask"</code> needs an operator to ask, and interactive is off.</span>
            </div>
            <button hlmBtn variant="secondary" type="button" (click)="enableInteractive()">Enable interactive</button>
          </div>
        }
      }
      @if (spec().permissions.mode === 'prompt' || spec().permissions.mode === 'auto') {
        <app-field
          label="Allow"
          key="permissions.allow"
          hint="one rule per line, claude's own grammar — Tool or Tool(specifier), * is a wildcard. e.g. Bash(git *)"
        >
          <textarea
            hlmTextarea
            rows="3"
            [placeholder]="ALLOW_PLACEHOLDER"
            [value]="rulesText(spec().permissions.allow)"
            (input)="setRules('allow', $event)"
          ></textarea>
        </app-field>
        <app-field
          label="Deny"
          key="permissions.deny"
          hint="evaluated before allow; claude checks these before its read-only auto-approve, so a deny reaches commands like git log too."
        >
          <textarea
            hlmTextarea
            rows="2"
            placeholder="Bash(rm *)"
            [value]="rulesText(spec().permissions.deny)"
            (input)="setRules('deny', $event)"
          ></textarea>
        </app-field>
        <app-field
          label="Ask"
          key="permissions.ask"
          hint="rules that always pause on the operator for a decision. Requires interactive mode enabled."
        >
          <textarea
            hlmTextarea
            rows="2"
            placeholder="Bash(git push *)"
            [value]="rulesText(spec().permissions.ask)"
            (input)="setRules('ask', $event)"
          ></textarea>
        </app-field>
        @if ((spec().permissions.ask ?? []).length > 0 && !spec().interactive.enabled) {
          <div class="wb-banner wb-banner--error" role="alert">
            <ng-icon name="lucideTriangleAlert" size="15" />
            <div class="wb-banner__list">
              <span><code>permissions.ask</code> rules need an operator to ask, and interactive is off.</span>
            </div>
            <button hlmBtn variant="secondary" type="button" (click)="enableInteractive()">Enable interactive</button>
          </div>
        }
      }
    </section>

    <app-prompt-dialog
      [open]="naming()"
      title="Save as preset"
      placeholder="Preset name"
      (confirm)="onSavePreset($event)"
      (cancel)="naming.set(false)"
    />
  `,
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

  protected readonly naming = signal(false);
  /** Bumped after each pick so the preset select is rebuilt and shows its placeholder again. */
  protected readonly pickerKey = signal(0);

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

  protected onPickPreset(name: unknown): void {
    const p = this.presets().find((x) => x.name === name);
    if (p) this.patch((s) => (s.context = appendContext(s.context, p.body)));
    this.pickerKey.update((k) => k + 1);
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
