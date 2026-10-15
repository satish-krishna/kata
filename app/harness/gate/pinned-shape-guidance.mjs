// PINNED STIMULUS of a published experiment. Do not "fix" a failure here by
// regenerating this fixture -- a failure means the wording an agent reads on a
// component-shape gate rejection has changed, not that this file is stale.
//
// .claude/hooks/check-component-shape-guided.mjs is the frozen "gate-on-guided"
// arm of the published A/B experiment (Part 3) that measured swapping a prose
// reminder for a worked example moving house-pattern adoption from 0/3 to 3/3
// runs. That hook imports SHAPE_FORMS_GUIDANCE from
// .claude/hooks/shape-guidance.mjs, and this branch changed that constant (and
// its three siblings) from a hardcoded literal into a value derived at module
// load from harness/rules/*.md. So the stimulus behind the measured result is
// now a function of a mutable markdown file, with no git history on the hook
// itself to show it.
//
// These four strings are the exact, byte-for-byte values SHAPE_FORMS_GUIDANCE,
// MVVM_GUIDANCE, ICON_GUIDANCE, and SUBMIT_GUIDANCE held BEFORE this branch
// touched the docs -- verified byte-identical to what they were before the
// markdown-derivation existed, so they are the correct baseline, not merely a
// snapshot of whatever the code currently produces.
//
// If a future edit to no-reactive-form.md, no-root-provided-view-model.md,
// no-state-outside-view-model.md, no-feature-inject-data.md,
// no-unprovided-view-model.md, no-legacy-icon-module.md, no-unregistered-icon.md,
// or no-orphan-ng-submit.md changes the rendered "## Agent guidance" body, the
// test that imports this fixture (harness/gate/rule-docs-hook.test.mjs) will
// fail. That failure is the point: it means someone changed what a measured
// experiment showed the agent. Resolve it by reverting the doc change, or by a
// deliberate, reviewed decision to re-run the experiment -- never by silently
// regenerating this file to match the new text.

export const SHAPE_FORMS_GUIDANCE = "\nUse the house forms pattern: Angular signal-forms driven by a zod schema.\nDo NOT hand-roll a form with a plain signal, a manual (change) handler, and a\nsafeParse on submit; that passes the rules but is not the pattern. Copy this exact shape:\n\n  // hero.schema.ts\n  import { z } from 'zod';\n  export const heroSchema = z.object({ name: z.string().min(1) });\n  export type HeroModel = z.infer<typeof heroSchema>;\n\n  // hero-detail.ts\n  import { form, submit, validateStandardSchema } from '@angular/forms/signals';\n  protected readonly model = signal<HeroModel>({ name: loadedHero.name });\n  protected readonly heroForm = form(this.model, (path) => validateStandardSchema(path, heroSchema));\n\n  <!-- template -->\n  <input hlmInput [formField]=\"heroForm.name\" />\n  @for (e of heroForm.name().errors(); track e.kind) { <hlm-field-error>{{ e.message }}</hlm-field-error> }\n\nRead the house-style skill's Forms section for the full example.";
export const MVVM_GUIDANCE = "\nUse the house MVVM pattern: a container owns its state through a component-scoped\nViewModel it provides and injects; it holds no signal()/computed() and injects no\ndata service itself. Copy this exact shape:\n\n  // hero-detail.view-model.ts\n  import { Injectable, inject, signal, computed } from '@angular/core';\n  import { HeroService } from './hero.service';\n\n  @Injectable() // no providedIn: this ViewModel is scoped to the component that provides it\n  export class HeroDetailViewModel {\n    private readonly heroes = inject(HeroService);\n    readonly query = signal('');\n    readonly filtered = computed(() => this.heroes.list().filter((h) => h.name.includes(this.query())));\n  }\n\n  // hero-detail.ts\n  @Component({\n    selector: 'app-hero-detail',\n    providers: [HeroDetailViewModel], // provided at component scope, where it is injected\n    template: `<p>{{ vm.filtered().length }}</p>`,\n  })\n  export class HeroDetail {\n    protected readonly vm = inject(HeroDetailViewModel); // inject the ViewModel, not the service\n    protected readonly route = inject(ActivatedRoute); // routing is still fine directly in the component\n    // no signal()/computed() and no inject(HeroService) here: the ViewModel owns both\n  }\n\nRead the house-style skill's MVVM section for the full example.";
export const ICON_GUIDANCE = "\nIcons: import the standalone NgIcon, never NgIconsModule, and register every\nicon the component renders with provideIcons. Copy this exact shape:\n\n  import { NgIcon, provideIcons } from '@ng-icons/core';\n  import { lucideUsers } from '@ng-icons/lucide';\n\n  @Component({\n    imports: [NgIcon],\n    providers: [provideIcons({ lucideUsers })],\n    template: `<ng-icon name=\"lucideUsers\" />`,\n  })\n\nDo NOT import NgIconsModule (throws at bootstrap), and do NOT register an icon\nthrough a custom token or a plain object (registers nothing): only provideIcons\nregisters an icon.\n\nRead the house-style skill's icons section for the full example.";
export const SUBMIT_GUIDANCE = "\nThere is exactly one submit path in this repo: submit(this.form, ...) from\n@angular/forms/signals. (ngSubmit) is not part of it; NgForm and\nFormGroupDirective, the only directives that fire it, ship with FormsModule and\nReactiveFormsModule, and this repo uses neither, so the binding is dead.\nCopy this exact shape:\n\n  <!-- template: no (ngSubmit) on the <form> -->\n  <form>\n    <hlm-field> ... </hlm-field>\n    <button hlmBtn type=\"submit\">Save</button>\n  </form>\n\n  // class: wire the submit through the form itself\n  import { submit } from '@angular/forms/signals';\n  protected readonly save = () => submit(this.form, async (f) => { /* ... */ });\n\nRead the house-style skill's \"Submitting a form\" section for the full example.";
