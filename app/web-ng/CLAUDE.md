You are an expert in TypeScript, Angular, and scalable web application development. You write functional, maintainable, performant, and accessible code following Angular and TypeScript best practices.

## TypeScript Best Practices

- Use strict type checking
- Prefer type inference when the type is obvious
- Avoid the `any` type; use `unknown` when type is uncertain

## Angular Best Practices

- Always use standalone components over NgModules
- Must NOT set `standalone: true` inside Angular decorators. It's the default in Angular v20+.
- Do NOT set `changeDetection: ChangeDetectionStrategy.OnPush` explicitly. `OnPush` is the default in Angular v22+.
- Use signals for state management
- Implement lazy loading for feature routes
- Do NOT use the `@HostBinding` and `@HostListener` decorators. Put host bindings inside the `host` object of the `@Component` or `@Directive` decorator instead
- Use `NgOptimizedImage` for all static images.
  - `NgOptimizedImage` does not work for inline base64 images.

## Accessibility Requirements

- It MUST pass all AXE checks.
- It MUST follow all WCAG AA minimums, including focus management, color contrast, and ARIA attributes.
- Every icon-only control needs an accessible name, and it should identify the record rather than repeat a generic verb: `[attr.aria-label]="'Edit ' + hero.name"`. Check first whether the primitive already supplies one — several render an `sr-only` span, and an explicit `aria-label` silently overrides it rather than adding to it.
- Heading level is a document-outline decision, not a component decision. `hlmCardTitle` is an attribute directive that attaches to any element, and the `<h3>` in spartan's examples is a placeholder. Pick the level the page needs; never skip one.
- Colour tokens are checked mechanically by `npm run check:contrast`. Text pairs must clear 4.5:1 and the focus ring 3:1, in both themes. A design document is not exempt: the palette that shipped at 2.80:1 came from a spec nobody had run the arithmetic on.

### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `model()` for two-way bound properties with `[(prop)]` syntax instead of pairing `input()` with `output()`
- Use `computed()` for derived state
- Use `linkedSignal()` for state derived from multiple reactive sources that must stay synchronized
- Prefer inline templates for small components
- Prefer Signal Forms (`@angular/forms/signals`) for new forms. They are stable in Angular v22+ and provide signal-based state, type-safe field access, and schema-based validation
- When not using Signal Forms, prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- When using external templates/styles, use paths relative to the component TS file.

## State Management

- Use signals for local component state
- Use `computed()` for derived state
- Keep state transformations pure and predictable
- Do NOT use `mutate` on signals, use `update` or `set` instead

## Component shape (MVVM)

Every routed screen is a thin component over a component-scoped ViewModel. This is enforced by five rules, so getting it wrong fails the build rather than the review.

- A ViewModel's class name ends in `ViewModel`. It is `@Injectable()` with **no** `providedIn`, and the component that uses it lists it in its own `providers: [XViewModel]`. A `providedIn: 'root'` ViewModel is a store wearing a different name; an injected-but-unprovided one is a `NullInjectorError` at runtime.
- A feature component holds no state. No property initialized with `signal()`, `computed()`, `linkedSignal()` or `form()`. All of it lives in the ViewModel and the template reads it off `vm`. Components under `src/app/ui/` are exempt, because a presentational form legitimately owns its own model.
- A feature component does not inject a data service — its ViewModel does. A `src/app/ui/` component injects nothing at all: inputs and outputs only. Note that any class whose name ends in `Service` counts, including `PreferencesService`.
- Never `.subscribe()` in a component or a ViewModel. Convert at the edge with `toSignal`, and prefer it to `route.snapshot`: the router reuses a component when only the id changes, so a snapshot read in `ngOnInit` shows the first record forever.
- Forms are Signal Forms over a zod schema, which is the single source of truth for shape, rules and field labels. Never restate a validator the schema already expresses, and never reach for `FormsModule`, `ReactiveFormsModule`, `ngModel` or `(ngSubmit)` — submission goes through `submission.action`.

**A method nobody calls is a bug, not dead weight.** `npm run check:wiring` fails on any public ViewModel or component member that no template references. Both of this project's worst shipped defects were exactly that: one left an Edit dialog opening onto an empty body, the other let a dismissed dialog make the next Create overwrite an unrelated record. Every counter read zero through both, because absent code is perfectly conformant.

## Verifying your work

Run these before claiming anything is done. A green board from an earlier state proves nothing about the tree in front of you.

```bash
npm run lint             # the 27 house rules
npm test                 # unit tests
npm run build            # production build
npm run check:boot       # every route renders without a runtime error
npm run check:interaction # every overlay opens, closes, logs nothing
npm run check:responsive # 375 / 768 / 1280
npm run check:contrast   # WCAG AA over the design tokens
npm run check:wiring     # no orphaned members
```

Know what each one cannot see. `check:boot` renders and never clicks, so it cannot exercise a dialog, a select or a tab panel. jsdom cannot drive a CDK overlay at all, so no unit test in this repo opens one. A drift counter measures the conformance of code that exists and is blind to code that was never written. When a test and a defect are on opposite sides of a boundary — a template that fails to call a ViewModel method, say — a test that calls the method directly will pass forever. Make the test cross the seam, and prove it by watching it fail before you trust it.

## When a gate blocks you

There are exactly two correct responses, and the guard's own message says so.

1. Satisfy the rule properly. Appearance on a primitive comes from its `variant`/`size` input or from editing the vendored copy under `libs/ui/` — that path is open and the gate ignores `libs/**`.
2. If you believe the rule itself is wrong, say so in your final response and stop. That happens: one rule here rejected the documented tab-trigger composition and its corrective message named the wrong fix, and the resulting defect was written exactly as instructed.

What is never acceptable is making the check unable to see the problem — relocating content onto a non-primitive element, adding a second directive to quiet a counter, repurposing an unrelated variant, or expressing a forbidden class through a `[class.x]` binding the classifier does not read. All of those pass. None of them comply.

## House frontend conventions

## Before you write spartan markup, ask the docs

The `spartan-ui` MCP server is configured and running. Use it. Reading a Helm file under `libs/ui/` tells you a component's SELECTOR and nothing about how it must be composed, and composition is where these primitives actually break.

- Before writing any `hlm-*` markup you have not written before, call the spartan MCP (`spartan_components_get`, `spartan_docs_get`) or read the matching `rules/*.md` in the `spartan` skill.
- Grepping `libs/ui/` is not a substitute. It gives you selectors, not required structure, and the difference is not cosmetic: `hlm-dialog-content` must sit on an `*hlmDialogPortal` template, because spartan supplies `BrnDialogRef` through that portal. Render it inline and it compiles, renders, and throws `NG0201` the moment the dialog opens.
- The same is true of every overlay, not just dialogs. `hlm-select-content` takes `*hlmSelectPortal` and `hlm-sheet-content` takes `*hlmSheetPortal`. The portal is what registers the content template with the overlay; without it the trigger silently does nothing and the content renders inline as permanently-visible DOM. The `no-unportalled-overlay` rule now rejects this at edit time, but it only knows the three families listed in its table.
- A dialog needs a way to close. Form components under `src/app/ui/` are presentational and know nothing about dialogs, so the host template drives it — a template reference on `<hlm-dialog>` whose `close()` the save and cancel handlers call. A dialog that writes its record and stays open lets a second click create a duplicate.
- The same applies to icons. `NgIconsModule` is the legacy API and throws at bootstrap; the standalone `NgIcon` plus `provideIcons` is the current one.

This is not a style preference. Every fatal runtime defect this repo has measured came from composing a primitive from its source rather than its documentation.

- Follow the `house-style` skill (`.claude/skills/house-style`) for layout and stylesheets, on top of the SpartanNG (`spartan` skill) docs. In short: grid for regions, flex for inline runs, never nest flex to fake a grid; and in any hand-written component stylesheet, colors and lengths are design tokens (`var(--...)`), never raw hex or `px`.

## Templates

- Keep templates simple and avoid complex logic
- Use native control flow (`@if`, `@for`, `@switch`) instead of `*ngIf`, `*ngFor`, `*ngSwitch`
- Use the async pipe to handle observables
- Do not assume globals like (`new Date()`) are available.

## Services

- Design services around a single responsibility
- Use the `providedIn: 'root'` option for singleton services
- Prefer the `@Service` decorator over `@Injectable({providedIn: 'root'})` for new singleton services (Angular v22+)
- Use the `inject()` function instead of constructor injection
