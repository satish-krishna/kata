# Kata Workbench — design rules and Angular conventions for Claude Code

Keep every session on the Workbench on-brand and on-convention. The Kata design system lives in `design/` (design tokens + component specs + prototypes), vendored into this app under `app/src/styles/kata/`. The frontend is Angular 22 (the angular-jig template) with SpartanNG (Brain headless primitives + Helm styled layer) skinned to the Kata system. Part 1 is the Kata design rules, part 2 the Angular house conventions and gate commands.

# Part 1: Kata design rules

## Foundation

- The app uses the **Kata design system**. `app/src/styles.css` imports `app/src/styles/kata/` once; it carries the dark "sumi-ink" theme, IBM Plex fonts, all tokens, and the `.k-*` component classes. The app-shell layout lives in `app/src/styles/kata/workbench.css`. Everything below is already defined there.
- **Style only against the CSS custom properties. Never hard-code a hex value.** The accent must stay a single-token change. `npx stylelint "src/**/*.css"` enforces it.

## Non-negotiables

- **Theme:** dark only — warm sumi-ink surfaces (`--surface-app/-panel/-card/-inset`), washi-paper text (`--text-primary/-secondary/-muted/-faint`). Never pure black/white, never a light theme.
- **Accent:** one — **Hanada azure** `--accent` (#1e92d8). Run button, focus rings, links, active segments, the seal, selection. One primary action per view.
- **Status:** the andon set — `--success` jade / `--warning` amber / `--error` crimson. Never reuse the accent for status; always pair a status colour with a dot **and** a label.
- **Type:** `--font-sans` (IBM Plex Sans) for UI; `--font-mono` (IBM Plex Mono) for all data — spec keys, paths, model ids, exit codes, cost, the event stream, uppercase micro-labels. **13px UI base** — do not drift up.
- **Surfaces:** inputs are *inset* (darker than their card); cards are **flat at rest** (no shadow); shadows only for floating things (dialogs, popovers, toasts). Tight radii, hairline borders. No gradients, images, textures, or glass in chrome.
- **Voice:** terse, exact, imperative; sentence-case labels; literal lowercase spec keys in mono. No emoji.
- **Icons:** `@ng-icons/lucide`, 1.5–2px stroke, `currentColor`. Register the icons a component uses with `provideIcons({ lucidePlay })` in its `providers` and render them with `<ng-icon name="lucidePlay" />`. The legacy `NgIconsModule` throws at bootstrap; never use it.
- **Controls are Helm primitives skinned in `libs/ui/`** (button, input, select, dialog, tabs, switch, ...). The Kata look is applied by editing the vendored copy under `libs/ui/`, or through the primitive's `variant`/`size` input — never by restyling a control at the call site. Use `variant="bare"` on a primitive when a Kata class (`.k-btn`, `.k-input`, ...) supplies the look.
- **Kata's non-control classes** (`.k-*` cards, event rows, toolcards, shell layout) live in `src/styles/kata/`, not in component stylesheets.
- **Windows only.** The Workbench ships on Windows alone, where Tauri renders through WebView2 (Chromium), so Chromium-only CSS such as `calc-size()` is allowed. Shipping to macOS or Linux (WebKit) would mean revisiting it.
- **Desktop only** (laptop → ultrawide). No mobile breakpoints. The window opens at 1280 wide and its minimum is 1280 by 800 (`minWidth` and `minHeight` in `src-tauri/tauri.conf.json`, which `check:responsive` asserts). `check:responsive` runs at 1280 and 1600 as a no-overflow check, and also covers the change page and the workspace home page at 1024, 1280 and 1600: the toolbar fits without overlap and gives way in the one order the table at the top of its CSS block (`workbench.css`) sets, for long workspace, change and branch names too; the Build strip never cuts a control off; nothing on the home page is cut off. Browser checks measure clipping with `scripts/clipping.mjs` (fractional rects and the rendered text width), never `scrollWidth - clientWidth`, which rounds a sub-pixel ellipsis away.
- **The build page has no narrow layout.** The window's minimum is 1280 by 800, and the build page shows its mode's arrangement of four areas (tasks, activity, changed files, findings) at that size, never one area at a time behind a switch. `npm run check:build` checks each mode's default at 1280 by 800 against `?demo=build-long`, a mock variant with enough repositories, tasks, files and findings to overflow every area: nothing cut off, every area scrolling on its own, every action on show or one click away.

## Where things live

- Tokens: `app/src/styles/kata/tokens/{colors,typography,spacing}.css`
- Component classes: `app/src/styles/kata/components.css`; base: `base.css`; shell layout: `workbench.css`
- Self-hosted fonts: `app/src/styles/kata/fonts/` + `app/src/styles/kata/fonts.css` (CSP blocks the CDN — the woff2 files are vendored and came from `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono`, which are no longer dependencies; install them temporarily to refresh)
- Presentational components: `app/src/app/ui/` (inputs and outputs only, no injection); routed screens: `app/src/app/workbench/`, `app/src/app/library/`, each a thin component over a component-scoped ViewModel
- Run store, launch store, toast store: `app/src/app/core/`; the transport seam (`KataTransport`) is `app/src/app/core/transport/`
- Helm primitives: `app/libs/ui/`
- Generated event and run-spec types: `app/src/bindings/` — never hand-edit (see the root `CLAUDE.md`)
- Per-component specs: `design/README.md`
- Pixel reference: `design/prototype/` (don't copy its code — it's HTML/React; recreate in Angular)

## Dev / review (browser without the native app)

- `npm start` serves on `http://localhost:1420`. Tauri `invoke`/`listen` are unreachable in a plain browser, so `provideKataTransport` picks the Mock transport (fixtures and the scripted timeline in `src/app/lib/mock.ts`) outside Tauri and the Tauri transport inside it.
- `http://localhost:1420/?demo=run` auto-starts the scripted Observe-pane run (browser-only, never under Tauri) — useful for screenshots.
- `http://localhost:1420/sdlc/claims/2026-10-12-fnol-photo-upload?demo=sdlc` starts a scripted AI-SDLC spec run that pauses on a question, and `http://localhost:1420/sdlc?demo=sdlc-setup` adds an un-set-up folder and plays the scripted setup run (both browser-only, never under Tauri). Cancelling either demo run opens the leftover dialog with fixture files.
- The run bridge (`run_spec`/`cancel_run` in `src-tauri/src/lib.rs`) relays `KataEvent`s over the `kata://event` channel; the frontend stays presentational (store: `src/app/core/run/run.store.ts`).
- The real engine path runs under Tauri only: `npm run tauri:dev` stages the `kata` sidecar (builds `kata-cli`, copies it to `src-tauri/binaries/kata-<target-triple>`) then launches the desktop app, which spawns `kata run` and relays its live JSON-lines. A real run needs an authenticated `claude` on PATH.
- The production build outputs to `dist/angular-jig/browser`; Tauri's `frontendDist` points there.
- The house rules are enforced by `npm run lint` and, during a Claude session, by the PostToolUse hooks wired at the repo root (`.claude/settings.json` calls `.claude/hooks/web-ng-gate.mjs`, which runs the hook files in `app/.claude/hooks/` for edits under `app/`).

# Part 2: Angular house conventions

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
- Every icon-only control needs an accessible name, and it should identify the record rather than repeat a generic verb: `[attr.aria-label]="'Delete ' + kata.name"`. Check first whether the primitive already supplies one — several render an `sr-only` span, and an explicit `aria-label` silently overrides it rather than adding to it.
- Heading level is a document-outline decision, not a component decision. `hlmCardTitle` is an attribute directive that attaches to any element, and the `<h3>` in spartan's examples is a placeholder. Pick the level the page needs; never skip one.
- `npm run check:contrast` is not wired in Kata: the harness reads only hex tokens and Kata's tokens are `var()` references, so it would pass vacuously. Check contrast by hand until that changes. Text pairs must clear 4.5:1 and the focus ring 3:1, in both themes. A design document is not exempt: the palette that shipped at 2.80:1 came from a spec nobody had run the arithmetic on.

### Components

- Keep components small and focused on a single responsibility
- Use `input()` and `output()` functions instead of decorators
- Use `model()` for two-way bound properties with `[(prop)]` syntax instead of pairing `input()` with `output()`
- Use `computed()` for derived state
- Use `linkedSignal()` for state derived from multiple reactive sources that must stay synchronized
- Every component keeps its template in a `.html` file beside it (`templateUrl`), never an inline `template:`, and never inline `styles:`. A component that needs its own styles gets a `styleUrl` file; one that doesn't gets none, since Kata's `.k-*` classes live in `src/styles/kata/`. Spec-file test hosts are exempt. `shape/no-inline-template` enforces it.
- Prefer Signal Forms (`@angular/forms/signals`) for new forms. They are stable in Angular v22+ and provide signal-based state, type-safe field access, and schema-based validation
- When not using Signal Forms, prefer Reactive forms instead of Template-driven ones
- Do NOT use `ngClass`, use `class` bindings instead
- Do NOT use `ngStyle`, use `style` bindings instead
- Template and style paths are relative to the component TS file, and the template file shares its basename (`event-row.ts` → `event-row.html`).

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
- Forms are Signal Forms over the generated `RunSpec` type. There is no zod: validation belongs to the engine (`validate_spec` under Tauri, `validateLocal` in browser mode), so never restate an engine rule in the form. Never reach for `FormsModule`, `ReactiveFormsModule`, `ngModel` or `(ngSubmit)` — submission goes through `submission.action`.

**`RunStore` folds every run, whatever is on screen.** A build runs several agents at once, and `LockStore.waiting()` reads `RunStore`, so a run in a hidden pane must keep folding its events or a waiting agent goes unseen. The build page therefore keeps all its run panes mounted and hides them, and never removes one. `npm run check:build` guards this; do not swap a hidden pane for an `@if`.

**Monaco never loads in a unit test.** Any spec that renders the diff editor stubs the loader with `vi.spyOn(monaco, 'load').mockReturnValue(new Promise(() => undefined))`, where `monaco` is `app/src/app/ui/diff-editor/monaco.loader.ts`, so the editor waits forever instead of fetching a few megabytes.

**A method nobody calls is a bug, not dead weight.** `npm run check:wiring` fails on any public ViewModel or component member that no template references. The classic instance is a dialog that opens onto an empty body because the template never calls the ViewModel method that fills it. Every drift counter reads zero through that, because absent code is perfectly conformant.

## Verifying your work

Run these before claiming anything is done. A green board from an earlier state proves nothing about the tree in front of you.

```bash
npm run lint             # the 28 house rules
npm test -- --watch=false # unit tests (plain `npm test` watches)
npm run build            # production build
npm run check:boot       # every route renders without a runtime error
npm run check:interaction # every overlay opens, closes, logs nothing
npm run check:responsive # 1280 / 1600 (desktop only)
# check:contrast is not wired in kata (harness reads only hex tokens; Kata's are var() references, so it would pass vacuously)
npm run check:wiring     # no orphaned members
```

Know what each one cannot see. `check:boot` renders and never clicks, so it cannot exercise a dialog, a select or a tab panel. jsdom cannot drive a CDK overlay at all, so no unit test in this repo opens one. A drift counter measures the conformance of code that exists and is blind to code that was never written. When a test and a defect are on opposite sides of a boundary — a template that fails to call a ViewModel method, say — a test that calls the method directly will pass forever. Make the test cross the seam, and prove it by watching it fail before you trust it.

## When a gate blocks you

There are exactly two correct responses, and the guard's own message says so.

1. Satisfy the rule properly. Appearance on a primitive comes from its `variant`/`size` input or from editing the vendored copy under `libs/ui/` — that path is open and the gate ignores `libs/**`.
2. If you believe the rule itself is wrong, say so in your final response and stop. That happens: one rule here rejected the documented tab-trigger composition and its corrective message named the wrong fix, and the resulting defect was written exactly as instructed.

A PreToolUse guard (`.claude/hooks/protect-gates.mjs` at the repo root) denies agent edits to the few files whose weakening nothing else would catch: `app/eslint.config.mjs`, `app/stylelint.config.mjs`, `app/harness/gate/rules/primitive-vocabulary.ts`, `app/harness/gate/rules/no-raw-control.ts`, and the guard itself. The owner edits those. Which other files an agent may edit depends on where the session starts.

- **Started at the repo root**, only the root guard runs. The rest of `harness/` stays editable because `npm run test:harness` runs in CI and turns red if a rule is gutted. `package.json`, `tsconfig*.json`, `.mcp.json` and `.claude/settings.json` stay editable because the diff and CI show any change.
- **Started in `app/`**, Claude Code also loads `app/.claude/settings.json`, which wires angular-jig's vendored `app/.claude/hooks/protect-enforcement.mjs` as a PreToolUse guard on every edit and shell command. Its protected list is wider than its denial message says: `harness/`, `.claude/hooks/`, `.claude/skills/`, `.claude/settings*.json`, `.agents/skills/`, `components.json`, `experiments/`, `package.json`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.harness.json`, `.mcp.json` and both lint configs. It matches path substrings in shell command text, so even a read-only `grep … package.json` through Bash is denied; read those files with the Read and Grep tools instead.

So from `app/`, adding a spartan primitive is an owner step. Vendoring its Helm files under `libs/ui/` is open, but registering it needs a `@spartan-ng/helm/<name>` path in `tsconfig.json` and its selectors in `harness/gate/rules/primitive-vocabulary.ts`. Hand the owner a patch for those two files rather than working around the guard.

What is never acceptable is making the check unable to see the problem — relocating content onto a non-primitive element, adding a second directive to quiet a counter, repurposing an unrelated variant, or expressing a forbidden class through a `[class.x]` binding the classifier does not read. All of those pass. None of them comply.

## House frontend conventions

## Before you write spartan markup, ask the docs

The `spartan-ui` MCP server is configured and running. Use it. Reading a Helm file under `libs/ui/` tells you a component's SELECTOR and nothing about how it must be composed, and composition is where these primitives actually break.

- Before writing any `hlm-*` markup you have not written before, call the spartan MCP (`spartan_components_get`, `spartan_docs_get`) or read the matching `rules/*.md` in the `spartan` skill.
- Grepping `libs/ui/` is not a substitute. It gives you selectors, not required structure, and the difference is not cosmetic: `hlm-dialog-content` must sit on an `*hlmDialogPortal` template, because spartan supplies `BrnDialogRef` through that portal. Render it inline and it compiles, renders, and throws `NG0201` the moment the dialog opens.
- The same is true of every overlay, not just dialogs. `hlm-select-content` takes `*hlmSelectPortal` and `hlm-sheet-content` takes `*hlmSheetPortal`. The portal is what registers the content template with the overlay; without it the trigger silently does nothing and the content renders inline as permanently-visible DOM. The `no-unportalled-overlay` rule now rejects this at edit time, but it only knows the five families listed in its table (dialog, sheet, select, alert-dialog, popover).
- A dialog needs a way to close. Form components under `src/app/ui/` are presentational and know nothing about dialogs, so the host template drives it — a template reference on `<hlm-dialog>` whose `close()` the save and cancel handlers call. A dialog that writes its record and stays open lets a second click create a duplicate.
- The same applies to icons. `NgIconsModule` is the legacy API and throws at bootstrap; the standalone `NgIcon` plus `provideIcons` is the current one.

This is not a style preference. Every fatal runtime defect this repo has measured came from composing a primitive from its source rather than its documentation.

- Follow the `house-style` skill (`app/.claude/skills/house-style`) for layout and stylesheets, on top of the SpartanNG (`spartan` skill) docs. In short: grid for regions, flex for inline runs, never nest flex to fake a grid; and in any hand-written component stylesheet, colors and lengths are design tokens (`var(--...)`), never raw hex or `px`.

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
