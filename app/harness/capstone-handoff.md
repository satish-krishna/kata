# Capstone handoff (run this from an angular-jig session)

Read this first, then use the spartan skill and the spartan MCP for all component work (install, selectors, APIs). This is the capstone of the Angular Blueprint series: expand the design-system vocabulary to a full kitchen-sink palette, build the richest honest Tour of Heroes as a conformance target, and run it through the gates. Do the work here, in a session rooted in this repo, so the agent under test inherits the real baseline (both MCP servers, the spartan skill, Angular's generated CLAUDE.md, the house-style skill). The blog repo owns the write-ups only.

The fuller planning context (the series playbook, the Part 5 result, the entropy thesis) lives in the blog repo at `docs/angular-jig-blueprint-playbook.md` and `docs/angular-jig-harness-resumption.md`. This file is the self-contained capstone brief.

## State

- `main` at `d206be4`. Parts 1-5 of the harness are built, measured, and green (`npm run test:harness`, 58 tests).
- Installed spartan components: only `button`, `input`, `card` (plus `libs/ui/utils`). The sealing vocabulary (Part 1) is exactly as wide as `libs/ui`, so there is no gap to close; the gap is what we are about to create by installing more.
- Part 5 finding to keep in mind: on natural Tour of Heroes, the gates are dormant because the model is competent on native patterns. The capstone is the deliberate non-native, dense target where the gates should finally bite.

## Model policy (Haiku is the subject, never the instrument)

Only the agent-under-test runs on Haiku. Everything else runs on the default (capable) model, and the orchestrating session picks the right model per subagent.

- **Haiku, always:** the measured capstone build, that is, the driver's headless `claude --model haiku` that builds Tour of Heroes under the gates (the gate-off and gate-on trials, and any from-zero capstone build). If you drive a build through a subagent instead of the driver, that build subagent is Haiku too. The experiment measures Haiku's drift; changing the agent-under-test model invalidates the result. The driver already hardcodes `MODEL = 'haiku'`; do not change it.
- **Default / capable model (NOT Haiku), orchestrator's choice per subagent:** everything that builds or grades the constitution and harness. That is the vocabulary extension (house-style doc, `sealing-spec.md`, the gate rules, the counter, the fixtures), the new icon rule, the MVVM rule, the off-canvas exemption, component installation, driver wiring, the Angular scaffolding, and every review. These are judgment work and they are the instrument that grades the experiment; a subtle gate bug written by Haiku would poison every published claim (a Sonnet review already caught one such bug this session). Use Sonnet for building and reviewing, the most capable model for the final whole-branch review, exactly as the Part 5 harness was built.

The rule in one line: the thing being measured is Haiku; the things doing the measuring are not.

## The palette (confirmed: full kitchen sink)

All twelve exist in this `@spartan-ng/cli@1.4.1` catalog by exact name, verified against `node_modules/@spartan-ng/cli/src/generators/ui/supported-ui-libraries.json`:

`table`, `select`, `dialog`, `tabs`, `badge`, `avatar`, `tooltip`, `switch`, `textarea`, `field`, `label`, `sidebar`.

Plus: icons (`@ng-icons` core + lucide) and a built theme switcher (light/dark). `card` is already installed; `input` is already installed (forms also want `field` + `label`, which are not).

## Catalog facts (verified, do not re-guess)

- Add a component: `ng g @spartan-ng/cli:ui <name>` (plain Angular CLI schematic; `ng` is not global, invoke via the spartan skill/MCP flow or `npx ng`). The schematic has NO `--skip-install` flag (it was rejected); its flags are `--interactive`, `--defaults`, `--dry-run`, `--force`, `--directory`, `--tags`. It ends by running an npm install, which is where npm 11.0.0's arborist `edgesOut` bug can bite. Prefer the spartan skill/MCP's own install path; if a raw add leaves deps unresolved, repair with `npx -y npm@latest install` (with the sandbox disabled). Confirm `npm run build` after.
- Icons: `@ng-icons/core` + `@ng-icons/lucide` (pulled in when a component that needs them is added). Pattern is per-component: `import { NgIcon, provideIcons } from '@ng-icons/core'`, `import { lucideX } from '@ng-icons/lucide'`, `providers: [provideIcons({ lucideX })]`, then `<ng-icon name="lucideX" />`. There is NO `hlm-icon` wrapper (retired; `migrate-icon` exists for that reason). Raw inline `<svg>` is the thing the new icon gate rule bans.
- Theme: a `.dark` class toggled on `<html>`. `src/styles.css` already defines `:root { ... }` and `:root.dark { ... }` including the full `--sidebar*` token set. Build the switcher with `document.documentElement.classList.toggle('dark')`; persist the choice.
- Sidebar: a real component (`HlmSidebar` + `HlmSidebarTrigger`, `HlmSidebarMenu*`, `HlmSidebarGroup*`, `HlmSidebarRail`, a service and a token). Install it; do not hand-compose. `navigation-menu` is a separate primitive if a top nav is also wanted.

## The plan

1. **Install the palette.** Add the twelve components via the spartan flow. Let icons/theme deps come in with them. Get `npm run build` green with everything installed (unused libs do not enter the build graph, so a clean build just proves the install did not break package.json/tsconfig).
2. **Expand the constitution (the "extend the vocabulary" work, which is also Part 7's content).** For each newly installed primitive that fits the existing raw-control shape (table, field, label, select, textarea, switch, dialog, tabs, badge, avatar, tooltip), extend, doc-first: the house-style skill (`.claude/skills/house-style/SKILL.md` and the byte-identical `.agents/skills/house-style/SKILL.md`), then `harness/sealing-spec.md`, then the gate (`harness/gate/index.mjs` and its rule files), the counter (`harness/counter/counter.mjs`), and the fixtures. The gate and counter must stay two independent engines encoding one spec, as they are today. Add a NEW rule kind for icons: no raw inline `<svg>`; register via `provideIcons` and render with `<ng-icon>`. The theme switcher is app code, not a vocabulary rule. The sidebar's smart/dumb placement is Part 3 (component-shape) territory, not Part 1 sealing.
3. **Build the rich prototype.** The conformance target is `prototype/capstone-build-spec.md`: a low-fidelity layout, build guidelines, the theme palette, and the icon scheme for a kitchen-sink Tour of Heroes reimagined as a "Hero Ops Console" (a superhero-agency mission control). It maps every region to a real spartan primitive (`hlm-table`, `hlm-select`, `hlm-dialog`, `hlm-tabs`, `hlm-sidebar`, `hlm-badge`, `hlm-avatar`, `hlm-tooltip`, `hlm-switch`, `hlm-field`/`hlm-label`, `ng-icon`), specifies the MVVM structure and the responsive rules the Part 5 gate enforces, and carries the palette and icon scheme. Build to intent and decisions, responsive at 375/768/1280, NOT to pixels. There is also a colour-and-mood HTML sketch at `prototype/tour-of-heroes.html`, but it is a reference ONLY: it is known non-responsive (measured 19 responsive-gate violations) and its CSS and layout mechanics must not be copied. IMPORTANT constitution to-do before the run: running the auditor on the rich layout showed off-canvas navigation (a closed mobile drawer parked off-screen) reads as `element-escape`; the Part 5 spec + auditor + gate need an exemption for a deliberately-hidden drawer (`display:none` / `aria-hidden`), updated together as two encodings of one spec. Detail is in the build spec.
4. **Run the capstone** the established way: gate-off vs gate-on, all gates present (Parts 1-5 plus the expanded vocabulary), drift counted by the independent counters (the AST counters plus the Part 5 Playwright responsive auditor), three trials per condition. Report the drift the baseline shipped, what the gates caught, and the residue.

## MVVM (the house pattern the capstone enforces; user definition, precise)

The ViewModel is an `@Injectable` service holding all logic and state as signals, unit-testable with zero DOM. The component is a thin shell that lists the VM in its own `providers: [XViewModel]` (component-scoped, NOT `providedIn: 'root'`), injects it, and binds the template to `vm` signals. This is idiomatic Angular (the ComponentStore/presenter shape, signal-native), not literal WPF. It is a new constitutional rule and is decidable/gateable: the component declares a `*ViewModel` in `providers` and injects it; state signals live in the VM, not the component class; the class stays thin. It REFINES Part 3 (which said the smart component holds the signals): the signals move into the VM. Write that reconciliation into the house doc deliberately, or the Part 3 shape gate and the MVVM rule will disagree about where state lives.

## What the capstone is really testing

The Parts 4-5 nulls produced the series' sharpest thesis: the gates fire in proportion to a pattern's distance from the model's priors. Native patterns are dormant; non-native house patterns (schema forms, MVVM-as-VM-service, a sealed table vocabulary) are where drift lives. The capstone aims dead at that non-native zone. It is also the place to measure the uniformity claim rather than assert it: the run driver already records `num_turns`, `cost_usd`, and `duration_ms` per trial, so a uniform-substrate vs varied-substrate comparison on those numbers turns the gut into a chart. Do not ship that claim as a gut; the blog's whole ethos is to run it.

## Harness and environment reminders

- Specs: `harness/sealing-spec.md` (Part 1), `harness/layout-grammar-spec.md` (2), `harness/component-shape-spec.md` (3), `harness/freeloader-spec.md` (4), `harness/responsive-spec.md` (5). Driver: `harness/driver/run-trial.mjs`. Tests: `npm run test:harness`.
- npm 11.0.0 arborist bug: install through `npx -y npm@latest install` with the sandbox disabled.
- File delete/rename under `D:\Repos` is sandbox-blocked: run all `git` natively (PowerShell), delete stray files natively.
- Never leave an untracked file in the repo root: the run driver refuses a trial when the tree is dirty outside `experiments/`.
- Run trials one at a time (they check out branches); run them in the background to dodge the 10-minute tool timeout.
- Publishing policy: the series ships as one, held in draft. Do not promote to `articles/`, flip status, add canonical, or make this repo public early.
