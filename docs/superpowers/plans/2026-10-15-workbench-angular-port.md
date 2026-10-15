# Workbench Angular Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SvelteKit Workbench frontend in `app/` with an Angular 22 app built on the angular-jig template, with no visible UX change.

**Architecture:** The Angular app is built side-by-side in `app/web-ng/` from a verbatim copy of `D:\Repos\angular-jig` (minus its Hero Ops domain). A `KataTransport` seam (Tauri or browser mock, chosen once at bootstrap) feeds a signal-based `RunStore` through a pure `reduce`. Component-scoped ViewModels own screen state, and presentational `ui/` components take inputs and emit outputs. A pixel-parity gate against a Svelte screenshot baseline must pass before one swap commit moves `web-ng` into `app/` and deletes Svelte.

**Tech Stack:** Angular 22.1 (zoneless, standalone, signals, Signal Forms), spartan-ng brain 1.4.1 + vendored helm in `libs/ui`, Tailwind 4, `@ng-icons/lucide`, Vitest via `@angular/build:unit-test`, Playwright, unified/remark/rehype for markdown, `diff`, Tauri v2 (`@tauri-apps/api`, `@tauri-apps/plugin-dialog`).

**Spec:** `docs/superpowers/specs/2026-10-15-workbench-angular-port-design.md`

## Global Constraints

- Branch `feat/angular-workbench`. Never commit to `main`.
- Every commit message ends with these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Cny7r941fACSM8LsAwG7Df`
- `app/src-tauri/` Rust code and Tauri command names are not changed by any task except Task 15's `tauri.conf.json` edits.
- Never hand-edit `app/src/bindings/`. Angular code imports bindings through the `@bindings/*` alias.
- Node for Angular work: `^22.22.3 || ^24.15.0` (Angular 22 engine floor). CI uses Node 24 for Angular jobs.
- angular-jig rules apply to all Angular code, enforced by `npm run lint`: no `standalone:` and no `changeDetection:` in `@Component` (OnPush is the v22 default); no `.subscribe(` in any component or `*ViewModel`; ViewModels are `@Injectable()` with no `providedIn` and are listed in their component's `providers`; feature components (outside `src/app/ui/`) declare no `signal`/`computed`/`form` properties; `ui/` components inject nothing but framework/`Hlm*` helpers; built-in control flow only; no `ngClass`/`ngStyle`; no literal `style="..."`; no inline `<svg>`; every native button/input/textarea/label/select/dialog is a helm primitive; no appearance classes on a primitive at the call site.
- CSS: colors, padding, margin, gap and border-radius are tokens (`var(--…)`) or the keywords `transparent currentColor inherit initial unset none auto 0` (enforced by stylelint).
- Do not edit anything `protect-enforcement.mjs` protects: `eslint.config.mjs`, `stylelint.config.mjs`, `harness/`, `.claude/settings*.json`, `.claude/hooks/`. Task 2 and Task 3 create these by copying. After they land, a change to one needs the owner's explicit sign-off.
- Dark theme only. Desktop only. No new UX. US English in code comments and docs. Markdown files use one line per paragraph (no hard wraps).
- Angular dev server on port 1420, strict.
- The run-spec and event contracts, exit codes, and `?demo=run` behavior are unchanged.

## Review Focus

- An emptied number field (max turns, timeout, budget, answer timeout) must store `null`, never `0` or `NaN`. Svelte's `bind:value` gives `null` today, and Signal Forms on `type="number"` may not. Pinned in Task 11.
- A `kata://event` delivered after Cancel, or after a fast Re-run, must not appear in the new run's transcript. Pinned in Task 6.
- A spec opened from disk with fields the form never shows (plugin `env`, permission `allow`/`deny` lists, `token_env`) must save back unchanged after editing one visible field, and the dirty flag must clear after Save. Pinned in Task 13.
- Assistant text containing raw HTML (`<img src=x onerror=alert(1)>`, `<script>`) must render inert. `svelte-exmarkdown` never rendered raw HTML, and the unified pipeline with `[innerHTML]` must not start. Pinned in Task 8.
- Ctrl/Cmd+Enter while a run is active, or while a dialog is open, must not start a second run. Pinned in Task 13.

## Execution notes

- Model per task (from the owner's CLAUDE.md): **Haiku** for Task 5 (mechanical copy), **Sonnet** for every other task. Escalate a stuck task one tier. Mid-implementation reviews run on Sonnet, and the final whole-branch review runs on **Opus** every time.
- Kata engine tests don't change and must stay green. Run `cargo test -p kata-core -p kata-cli` once in Task 15.
- Commands in `app/web-ng/` run from that directory unless stated.

## File structure (end state, before the swap)

```
app/web-ng/                         verbatim angular-jig workspace (renamed kata-workbench)
  angular.json, package.json, tsconfig*.json, eslint.config.mjs, stylelint.config.mjs,
  .postcssrc.json, .prettierrc, .editorconfig, components.json, harness/, libs/ui/
  .claude/hooks/                    copied verbatim; wired from the kata root in Task 3
  parity/baseline/*.png             Svelte baseline (Task 1)
  parity/capture.mjs                shared view list + capture routine (Task 1)
  scripts/check-parity.mjs          Angular capture + pixel diff (Task 4)
  scripts/check-responsive-desktop.mjs
  src/index.html, src/main.ts, src/styles.css
  src/styles/kata/                  fonts.css, fonts/*.woff2, tokens/*.css, base.css, components.css, workbench.css
  src/testing/render.ts             TestBed render helper for ported component tests
  src/app/app.ts, app.config.ts, app.routes.ts, app-shell.view-model.ts
  src/app/lib/                      events, toolcards, spec, kit, katas, scroll, library, mock (+ *.spec.ts)
  src/app/core/transport/           kata-transport.ts, tauri-transport.ts, mock-transport.ts, provide-kata-transport.ts (+ specs)
  src/app/core/run/                 reduce.ts, run.store.ts (+ specs)
  src/app/core/toast/toast.store.ts, core/launch/launch.store.ts (+ specs)
  src/app/ui/                       flat files, one presentational component each (angular-jig layout)
  src/app/workbench/                workbench.ts, workbench.html, workbench.view-model.ts (+ specs)
  src/app/library/                  library.ts, library.html, library.view-model.ts (+ specs)
app/src-tauri/tauri.ng.conf.json    side-by-side override (removed at swap)
```

## Svelte → Angular conversion rules (used by Tasks 7-14)

| Svelte | Angular |
|---|---|
| `let { a, b = 1 }: {...} = $props()` | `readonly a = input.required<T>(); readonly b = input<T>(1);` |
| callback prop `onRun: (x) => void` | `readonly run = output<X>();` emitted with `this.run.emit(x)`; the parent binds `(run)="vm.run($event)"` |
| `$bindable` prop | `model<T>()` |
| `$state` local UI state inside a `ui/` component (open/closed, draft text, query) | `signal()` in the `ui/` component, allowed there |
| `$derived(expr)` | `computed(() => expr)` |
| `$effect` | `effect()` only if it is a real side effect (focus, scroll); prefer `computed` |
| `{#if}` / `{:else if}` / `{#each xs as x (key)}` | `@if` / `@else if` / `@for (x of xs(); track key)` |
| `class="k-x k-x--{v}"` | `class="k-x" [class]="'k-x--' + v()"` or `[class.k-x--on]="on()"` |
| `style="..."` | a class in `src/styles/kata/components.css` using tokens |
| `<Icon size={15} />` from `@lucide/svelte` | `<ng-icon name="lucideIcon" size="15" />` with `provideIcons({ lucideIcon })` in that component's `providers` |
| `<button class="k-btn k-btn--primary">` | `<button hlmBtn variant="primary">` (variants defined in Task 4) |
| `<input class="k-input">` / `<textarea class="k-textarea">` | `<input hlmInput>` / `<textarea hlmTextarea>` |
| `<input type="checkbox">` inside `.k-check` | `<hlm-checkbox>` (added in Task 4) |
| `.k-seg` segmented buttons | `hlm-toggle-group` (added in Task 4) |
| `.k-dialog` scrim+dialog | `hlm-dialog` + `<hlm-dialog-content *hlmDialogPortal>` + `hlmDialogTitle` |
| `goto("/")` | `inject(Router).navigate(['/'])` in a ViewModel |
| mutating a `$state` object (`spec.skills.push(x)`) | never mutate in place: compute a new value and `.set()` it |

Ported component tests use `src/testing/render.ts` (Task 2) so each test body stays close to the Svelte original: `const { container, fixture } = await render(EventRow, { ev })`. `screen` queries become `container.querySelector`, or `within(container)` from `@testing-library/dom`, which is already a kata dependency. Add it to `web-ng` devDependencies in Task 2. `fireEvent.click(el)` becomes `el.click(); await fixture.whenStable();`.

---

### Task 1: Svelte parity baseline

**Model:** Sonnet

**Files:**
- Create: `app/web-ng/parity/capture.mjs`
- Modify: `app/scripts/screenshots.mjs`
- Create: `app/web-ng/parity/baseline/*.png` (generated)
- Modify: `app/package.json` (script `parity:baseline`)

**Interfaces:**
- Produces: `export const VIEWS: Array<{ name: string; path: string; ready: string; act?: (page) => Promise<void> }>` and `export async function captureAll(base: string, outDir: string): Promise<string[]>` in `parity/capture.mjs`. Viewport `{ width: 1440, height: 900 }`, `deviceScaleFactor: 1` (1x keeps diffs fast; the release screenshots stay 2x). Task 4 imports both.

- [ ] **Step 1: Write `parity/capture.mjs`**

Move the browser-launch and `ready`/`shoot` helpers out of `screenshots.mjs` into this module, and define the view list. Each view navigates fresh and leaves no state for the next. The selectors come from the current Svelte DOM; confirm each one against `app/src/` before relying on it.

```js
// Shared parity view list. Imported by the Svelte baseline capture (app/scripts/screenshots.mjs
// --parity) and by the Angular check (app/web-ng/scripts/check-parity.mjs). One list, so the
// two sides can never capture different views.
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';

export const VIEWPORT = { width: 1440, height: 900 };

async function answerAsk(page) {
  const groups = page.locator('.k-ask__q');
  for (let i = 0; i < (await groups.count()); i++) {
    const g = groups.nth(i);
    if (await g.locator('textarea').count()) { await g.locator('textarea').fill('Confirmed — proceed.'); continue; }
    const opt = g.locator('.k-ask__opt, .k-ask__confirm-btn').first();
    if (await opt.count()) await opt.click();
  }
  await page.locator('.k-ask__foot button').filter({ hasText: /submit|answer/i }).first().click();
}

export const VIEWS = [
  { name: 'compose-seeded', path: '/', ready: '.wb-toolbar' },
  { name: 'compose-kit-search', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.locator('.k-kit input').first().fill('git'); } },
  { name: 'compose-new-empty', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.getByRole('button', { name: /new/i }).click();
      const discard = p.getByRole('button', { name: /discard/i });
      if (await discard.count()) await discard.click(); } },
  { name: 'compose-validation', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.getByRole('button', { name: /new/i }).click();
      const discard = p.getByRole('button', { name: /discard/i });
      if (await discard.count()) await discard.click();
      await p.getByRole('button', { name: /^run/i }).click(); await p.waitForSelector('.wb-banner'); } },
  { name: 'dialog-discard', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.locator('textarea').first().fill('changed'); await p.getByRole('button', { name: /new/i }).click(); } },
  { name: 'dialog-save-preset', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.getByRole('button', { name: /save as preset|preset/i }).first().click(); } },
  { name: 'observe-ask', path: '/?demo=run', ready: '.k-ask' },
  { name: 'observe-permission', path: '/?demo=run', ready: '.k-ask',
    act: async (p) => { await answerAsk(p); await p.getByRole('button', { name: 'Allow · resume' }).waitFor({ timeout: 15000 }); } },
  { name: 'observe-complete', path: '/?demo=run', ready: '.k-ask',
    act: async (p) => { await answerAsk(p); const a = p.getByRole('button', { name: 'Allow · resume' });
      await a.waitFor({ timeout: 15000 }); await a.click(); await p.waitForSelector('.wb-summary', { timeout: 15000 }); } },
  { name: 'observe-toolcards-open', path: '/?demo=run', ready: '.k-ask',
    act: async (p) => { await answerAsk(p); const a = p.getByRole('button', { name: 'Allow · resume' });
      await a.waitFor({ timeout: 15000 }); await a.click(); await p.waitForSelector('.wb-summary', { timeout: 15000 });
      const rows = p.locator('.k-toolcard__row');
      for (let i = 0; i < (await rows.count()); i++) { const r = rows.nth(i); if ((await r.getAttribute('aria-expanded')) === 'false') await r.click(); } } },
  { name: 'library-list', path: '/library', ready: '.wb-kata' },
  { name: 'library-detail', path: '/library', ready: '.wb-kata',
    act: async (p) => { await p.locator('.wb-run, .wb-history__row').first().click(); } },
  { name: 'focus-primary', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.keyboard.press('Tab'); await p.keyboard.press('Tab'); } },
  { name: 'hover-secondary', path: '/', ready: '.wb-toolbar',
    act: async (p) => { await p.getByRole('button', { name: /open/i }).hover(); } },
];

export async function launchBrowser() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }); }
    catch (e) { if (channel === 'msedge') throw new Error(`Could not launch Chrome or Edge.\n${e.message}`); }
  }
}

export async function captureAll(base, outDir) {
  await mkdir(outDir, { recursive: true });
  const browser = await launchBrowser();
  const written = [];
  try {
    for (const v of VIEWS) {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(base + v.path, { waitUntil: 'networkidle' });
      await page.waitForSelector(v.ready, { state: 'visible', timeout: 30000 });
      if (v.act) await v.act(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(450);
      const file = join(outDir, `${v.name}.png`);
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      written.push(file);
      await page.close();
    }
  } finally { await browser.close(); }
  return written;
}
```

- [ ] **Step 2: Fix every selector against the Svelte source**

For each view in `VIEWS`, open the Svelte component that renders it and confirm the selector and button label. Known guesses to check: the kit search input (`KitChecklist.svelte`), the save-preset trigger (`ComposePane.svelte`), the library row class (`routes/library/+page.svelte`), the ask submit button text (`AskPanel.svelte`), and whether `.k-toolcard__row` carries `aria-expanded` (`ToolCard.svelte`). Correct `VIEWS` in place. Every view must reach its `ready` selector and finish its `act` without a timeout.

- [ ] **Step 3: Add `--parity` mode to `app/scripts/screenshots.mjs`**

When `--parity` is passed, serve Vite exactly as today, then call `captureAll(base, resolve(appRoot, 'web-ng/parity/baseline'))` instead of the four release shots. Import with `import { captureAll } from '../web-ng/parity/capture.mjs';`. Add to `app/package.json` scripts: `"parity:baseline": "node scripts/screenshots.mjs --parity"`.

- [ ] **Step 4: Run it and inspect**

Run (in `app/`): `npm run parity:baseline`
Expected: `14 screenshot(s) written`. Open every PNG and confirm it shows the intended state: the dialog is visible in the dialog views, the banner in `compose-validation`, every tool card expanded in `observe-toolcards-open`. A PNG that shows the wrong state means a wrong selector, so go back to Step 2.

- [ ] **Step 5: Confirm determinism**

Run `npm run parity:baseline` a second time into a temp dir (`SCREENSHOTS_OUT` is ignored in parity mode, so copy `baseline/` aside first), then byte-compare: `node -e "const fs=require('fs');for(const f of fs.readdirSync('a'))if(!fs.readFileSync('a/'+f).equals(fs.readFileSync('b/'+f)))console.log('DIFF',f)"`.
Expected: no `DIFF` lines. Fix any nondeterminism (a timestamp, a blinking caret, a running timer) in the act or wait before continuing. A noisy baseline makes the parity gate meaningless.

- [ ] **Step 6: Commit**

```bash
git add app/scripts/screenshots.mjs app/package.json app/web-ng/parity
git commit -m "test(workbench): Svelte parity baseline for the Angular port"
```

---

### Task 2: Scaffold `app/web-ng` from angular-jig

**Model:** Sonnet

**Files:**
- Create: `app/web-ng/**` (copied from `D:\Repos\angular-jig`)
- Create: `app/web-ng/src/testing/render.ts`, `app/web-ng/src/app/workbench/workbench.ts`, `app/web-ng/src/app/library/library.ts` (placeholders)
- Create: `app/src-tauri/tauri.ng.conf.json`
- Modify: `app/package.json` (script `tauri:dev:ng`), `.github/workflows/ci.yml` (job `web-ng`), `.gitignore`

**Interfaces:**
- Produces: the `@bindings/*` alias; `render<T>(cmp: Type<T>, inputs?: Record<string, unknown>, providers?: Provider[]): Promise<{ fixture: ComponentFixture<T>; container: HTMLElement }>`; routes `''` → `Workbench` and `'library'` → `Library`; `npm start` serving on 1420.

- [ ] **Step 1: Copy the template's tracked files**

```bash
cd /d/Repos/angular-jig
git archive --format=tar HEAD | (mkdir -p /d/Repos/kata/app/web-ng && tar -x -C /d/Repos/kata/app/web-ng --exclude='src/app/*' --exclude='docs' --exclude='prototype' --exclude='.superpowers' --exclude='README.md' --exclude='.vscode' --exclude='skills-lock.json')
```

`parity/` from Task 1 is untouched because the archive has no `parity/` directory. Keep `harness/` whole, since `eslint.config.mjs` imports `harness/gate/index.mjs` and `harness/gate/component-shape-index.mjs`.

- [ ] **Step 2: Rename and configure**

- `package.json`: `"name": "kata-workbench"`; add `"engines": { "node": "^22.22.3 || ^24.15.0" }`; change `"start"` to `"ng serve --port 1420"`; add devDependency `"@testing-library/dom": "^10.4.1"` and dependencies `"@tauri-apps/api": "2.11.0"`, `"@tauri-apps/plugin-dialog": "2.7.1"`, `"diff": "9.0.0"`, `"unified": "^11.0.5"`, `"remark-parse": "^11.0.0"`, `"remark-gfm": "4.0.1"`, `"remark-rehype": "^11.1.2"`, `"rehype-sanitize": "^6.0.0"`, `"rehype-stringify": "^10.0.1"`. Remove `zod` (spec: no zod).
- `angular.json`: rename project key `angular-jig` → `kata-workbench` and both `buildTarget` strings. Under `serve.options` add `"port": 1420`. Raise the `anyComponentStyle` budget only if a later task needs it.
- `tsconfig.json` `paths`: add `"@bindings/*": ["../src/bindings/*"]`.
- `tsconfig.app.json` `include`: add `"../src/bindings/**/*.ts"`.
- `src/index.html`: `<title>Kata Workbench</title>`.
- `.gitignore` (repo root): add `app/web-ng/dist/`, `app/web-ng/.angular/`, `app/web-ng/node_modules/`, `app/web-ng/parity/actual/`, `app/web-ng/parity/diff/`.

- [ ] **Step 3: Replace the app shell with placeholders**

`src/app/app.routes.ts`:

```ts
import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', loadComponent: () => import('./workbench/workbench').then((m) => m.Workbench) },
  { path: 'library', loadComponent: () => import('./library/library').then((m) => m.Library) },
];
```

`src/app/workbench/workbench.ts` and `src/app/library/library.ts` are each `@Component({ selector: 'app-workbench', template: '<div class="wb-toolbar"></div>' }) export class Workbench {}` (and `app-library` / `Library` / `wb-kata` respectively). The archive excluded all of angular-jig's `src/app/`, so write the shell files from scratch. Icons are registered per component with `provideIcons`, so there is no app-level icon list.

`src/app/app.config.ts`:

```ts
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideSpartanHlm } from '@spartan-ng/helm/utils';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideRouter(routes), provideSpartanHlm()],
};
```

`src/app/app.ts`:

```ts
import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
export class App {}
```

Confirm that `src/main.ts` (copied) imports `./app/app.config` and `./app/app`, and adjust the import names if it doesn't. Task 7 adds the toaster to this shell.

- [ ] **Step 4: Write `src/testing/render.ts`**

```ts
import { Provider, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

/** Mount a standalone component with its inputs set, the way @testing-library's
 *  render() did for the Svelte tests, so ported test bodies stay recognizable. */
export async function render<T>(
  cmp: Type<T>,
  inputs: Record<string, unknown> = {},
  providers: Provider[] = [],
): Promise<{ fixture: ComponentFixture<T>; container: HTMLElement }> {
  TestBed.configureTestingModule({ imports: [cmp], providers });
  const fixture = TestBed.createComponent(cmp);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  await fixture.whenStable();
  return { fixture, container: fixture.nativeElement as HTMLElement };
}
```

- [ ] **Step 5: Write a failing smoke spec, then make it pass**

`src/app/app.routes.spec.ts`:

```ts
import { routes } from './app.routes';

describe('routes', () => {
  it('maps the two Workbench screens', () => {
    expect(routes.map((r) => r.path)).toEqual(['', 'library']);
  });
});
```

Run: `npm ci && npm test`
Expected: PASS. If install fails on the engines check, switch to Node 24.

- [ ] **Step 6: Gate the scaffold**

Add to `package.json` scripts: `"check:boot": "node harness/gate/check-boot.mjs --route '' --route library"` and `"check:interaction": "node harness/gate/check-interaction.mjs --route '' --route library"`. Confirm how `check-boot.mjs` serves the app (around line 163) and that an empty route string is accepted. If it isn't, pass `--route /` instead.

Run: `npm run lint && npx stylelint "src/**/*.css" && npm run build && npm run check:boot`
Expected: all pass, and `boot check passed: 2 route(s)`.

- [ ] **Step 7: Side-by-side Tauri launch**

`app/src-tauri/tauri.ng.conf.json`:

```json
{
  "build": {
    "beforeDevCommand": "npm --prefix ../web-ng start",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm --prefix ../web-ng run build",
    "frontendDist": "../web-ng/dist/kata-workbench/browser"
  }
}
```

`app/package.json` scripts: `"tauri:dev:ng": "node scripts/stage-sidecar.mjs && tauri dev --config src-tauri/tauri.ng.conf.json"`. Confirm the dist folder name with `ls app/web-ng/dist` after the build in Step 6.

- [ ] **Step 8: CI job**

Append to `.github/workflows/ci.yml`, matching the `web` job's style:

```yaml
  web-ng:
    name: Workbench Angular (lint · build · test)
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: app/web-ng
    steps:
      - uses: actions/checkout@v7
      - name: Install Node
        uses: actions/setup-node@v6
        with:
          node-version: "24"
          cache: npm
          cache-dependency-path: app/web-ng/package-lock.json
      - run: npm ci
      - name: Lint (ESLint seal + shape)
        run: npm run lint
      - name: Stylelint (token gate)
        run: npx stylelint "src/**/*.css"
      - name: Build
        run: npm run build
      - name: Unit tests (Vitest)
        run: npm test -- --watch=false
      - name: Install Playwright Chromium
        run: npx playwright install --with-deps chromium
      - name: Boot check
        run: npm run check:boot
```

- [ ] **Step 9: Commit**

```bash
git add app/web-ng app/src-tauri/tauri.ng.conf.json app/package.json .github/workflows/ci.yml .gitignore
git commit -m "feat(workbench-ng): scaffold Angular app from angular-jig"
```

---

### Task 3: Wire angular-jig's hooks, skills and MCP servers at the kata root

**Model:** Sonnet

**Files:**
- Modify: `.claude/settings.json` (kata root)
- Create: `.claude/skills/house-style/`, `.claude/skills/spartan/` (copied from `app/web-ng/.claude/skills/`)
- Create or modify: `.mcp.json` (kata root)

**Interfaces:**
- Produces: PreToolUse/PostToolUse hooks that run jig's checks on edits under `app/web-ng/` and stay silent on every other path.

- [ ] **Step 1: Learn each hook's path filter**

Read the first ~60 lines of each of `seal-templates.mjs`, `check-layout.mjs`, `check-component-shape.mjs`, `check-freeloader.mjs` and `protect-enforcement.mjs` in `app/web-ng/.claude/hooks/`. For each one, note how it reads `tool_input.file_path` from stdin JSON, which extensions or paths it ignores, and what it resolves relative to `process.cwd()`.

- [ ] **Step 2: Write the failing check**

Create `C:\Users\psati\AppData\Local\Temp\claude\hookcheck.sh` (scratch, not committed):

```bash
#!/usr/bin/env bash
# Usage: hookcheck.sh <hook.mjs> <absolute file path>   -> prints exit code + stderr
cd /d/Repos/kata/app/web-ng
printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$2" | node ".claude/hooks/$1"; echo "exit=$?"
```

Create a deliberately bad template at `app/web-ng/src/app/ui/zz-bad.ts` containing `@Component({ selector: 'app-zz', template: '<button>x</button>' }) export class ZzBad {}`.

Run: `bash hookcheck.sh seal-templates.mjs D:/Repos/kata/app/web-ng/src/app/ui/zz-bad.ts`
Expected: non-zero exit with a `no-raw-control` message, which proves the hook works from the `web-ng` cwd.

Run: `bash hookcheck.sh seal-templates.mjs D:/Repos/kata/crates/kata-core/src/run.rs`
Expected: `exit=0` and no output. If a hook fires or crashes on a non-Angular path, stop and report it to the owner. Do not edit the hook.

- [ ] **Step 3: Wire the hooks at the kata root**

Merge into `.claude/settings.json`, keeping `prefersReducedMotion` and `outputStyle`:

```json
"hooks": {
  "PreToolUse": [
    { "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell",
      "hooks": [ { "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR/app/web-ng\" && node .claude/hooks/protect-enforcement.mjs" } ] }
  ],
  "PostToolUse": [
    { "matcher": "Write|Edit|MultiEdit",
      "hooks": [
        { "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR/app/web-ng\" && node .claude/hooks/seal-templates.mjs" },
        { "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR/app/web-ng\" && node .claude/hooks/check-layout.mjs" },
        { "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR/app/web-ng\" && node .claude/hooks/check-component-shape.mjs" },
        { "type": "command", "command": "cd \"$CLAUDE_PROJECT_DIR/app/web-ng\" && node .claude/hooks/check-freeloader.mjs" }
      ] }
  ]
}
```

`protect-enforcement.mjs` matches protected names like `harness/` and `eslint.config.mjs`. Check with the Step 2 script that a PreToolUse payload for `D:/Repos/kata/crates/kata-core/src/run.rs` exits 0. Also check one for `D:/Repos/kata/app/web-ng/eslint.config.mjs`: it should block.

- [ ] **Step 4: Copy skills and MCP servers**

Copy `app/web-ng/.claude/skills/house-style` and `app/web-ng/.claude/skills/spartan` to `.claude/skills/`. Merge the two `mcpServers` entries (`angular-cli`, `spartan-ui`) from `app/web-ng/.mcp.json` into a root `.mcp.json`, and delete `app/web-ng/.mcp.json`. Leave `app/web-ng/.claude/` in place: the hooks live there, and `rule-docs.mjs` resolves the rule docs relative to it.

- [ ] **Step 5: Clean up and commit**

Delete `src/app/ui/zz-bad.ts`.

```bash
git add .claude/settings.json .claude/skills .mcp.json app/web-ng/.mcp.json
git commit -m "chore: wire angular-jig edit-time gates and skills at the repo root"
```

---

### Task 4: Kata theme, primitive skins, parity check

**Model:** Sonnet

**Files:**
- Create: `app/web-ng/src/styles/kata/` (copied from `app/src/styles/`: `fonts.css`, `fonts/*.woff2`, `tokens/*.css`, `base.css`, `components/components.css` → `components.css`, `workbench.css` from `app/src/styles/workbench.css`)
- Modify: `app/web-ng/src/styles.css`
- Modify: `app/web-ng/libs/ui/button/src/lib/hlm-button.ts`, `libs/ui/input/…`, `libs/ui/textarea/…`, `libs/ui/dialog/…`, `libs/ui/label/…`, `libs/ui/select/…`
- Create: `libs/ui/checkbox/`, `libs/ui/toggle-group/` (spartan CLI)
- Create: `app/web-ng/scripts/check-parity.mjs`, `app/web-ng/scripts/check-responsive-desktop.mjs`
- Modify: `app/web-ng/package.json`

**Interfaces:**
- Consumes: `VIEWS`, `captureAll` from `parity/capture.mjs` (Task 1).
- Produces: button variants `primary | secondary | ghost | danger` and sizes `default | sm | lg | icon`; `<hlm-checkbox>`; `hlm-toggle-group`/`hlmToggleGroupItem`; `npm run check:parity [-- --only name,name]`; `npm run check:responsive`; `npm run check:contrast`.

- [ ] **Step 1: Copy the token layer**

Copy the files listed above. In `components.css`, delete the control rules that primitives now own: `.k-btn*`, `.k-input*`, `.k-textarea*`, `.k-select*`, `.k-check*`, `.k-seg*`, `.k-dialog*`, `.k-field__label`. Keep the deleted text in a scratch file, because Step 3 transcribes it into helm. Fix the two literal paddings stylelint will reject (`padding: 4px var(--space-3)` → `padding: var(--space-1) var(--space-3)`, `padding: 1px 4px` → `padding: var(--space-px) var(--space-1)`), after confirming in `tokens/spacing.css` that `--space-1` is 4px and `--space-px` is 1px. Replace `workbench.css`'s Hiragino seal font and its 10px/11px sizes with new tokens in `tokens/typography.css` that hold the same values (`--font-seal`, `--text-3xs: 10px`, and reuse `--text-2xs` if it is already 11px).

- [ ] **Step 2: Write `src/styles.css`**

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/preflight.css' layer(base);
@import 'tailwindcss/utilities.css';
@import '@spartan-ng/brain/hlm-tailwind-preset.css';

/* Kata's sumi-ink design system. Its tokens sit on :root outside any layer, so
   where a name matches a Tailwind theme variable (--font-sans, --text-sm,
   --radius-md, --shadow-sm, ...) Kata's value wins. That is how the helm
   primitives pick up Kata's type and radius scale. */
@import './styles/kata/fonts.css';
@import './styles/kata/tokens/colors.css';
@import './styles/kata/tokens/typography.css';
@import './styles/kata/tokens/spacing.css';
@import './styles/kata/base.css' layer(base);
@import './styles/kata/components.css' layer(components);
@import './styles/kata/workbench.css' layer(components);

/* spartan's semantic tokens, defined from Kata's. Dark only: there is no .dark toggle. */
:root {
  color-scheme: dark;
  --background: var(--surface-app);
  --foreground: var(--text-primary);
  --card: var(--surface-card);
  --card-foreground: var(--text-primary);
  --popover: var(--surface-card);
  --popover-foreground: var(--text-primary);
  --primary: var(--accent);
  --primary-foreground: var(--text-on-accent);
  --secondary: var(--surface-card);
  --secondary-foreground: var(--text-primary);
  --muted: var(--surface-inset);
  --muted-foreground: var(--text-muted);
  --destructive: var(--error);
  --border: var(--border-default);
  --input: var(--border-default);
  --ring: var(--accent);
  --radius: var(--radius-sm);
}

/* spartan's --accent is a neutral hover surface; Kata's --accent is Hanada azure
   and keeps its name. Point Tailwind's accent utilities at the hover surface. */
@theme inline {
  --color-accent: var(--surface-hover);
  --color-accent-foreground: var(--text-primary);
}
```

Delete angular-jig's Hero Ops `:root` / `:root.dark` palettes and its `--font-sans` stack, because Kata's tokens replace them. Tailwind's preflight and Kata's `base.css` overlap (box-sizing, margins, `font: inherit` on controls), and the parity check decides any conflict. Run: `npm run build && npx stylelint "src/**/*.css"` → PASS.

- [ ] **Step 3: Skin the primitives**

The deleted `.k-*` rules from Step 1 are the spec for each primitive. Transcribe them into each helm file's class list (`cva` variants) using Tailwind arbitrary-value utilities over Kata tokens, for example `bg-[var(--accent)] text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-press)] h-[var(--control-h)]`. A dimension in `.k-btn` that has no token (`height: 26px` for `--sm`, `38px` for `--lg`, the base height) gets a new token in `tokens/spacing.css` holding the same value. Work through each primitive:

- `hlm-button.ts`: replace the variants with `primary`, `secondary`, `ghost`, `danger` (and keep `link` if anything uses it) and sizes `default`, `sm`, `lg`, `icon`, matching `.k-btn` plus `.k-btn--*`. Include `:active` translate, `:disabled` opacity 0.45, and 16px icons.
- `hlm-input`, `hlm-textarea`: `.k-input` / `.k-textarea` (inset surface, focus ring `0 0 0 3px var(--accent-subtle)`, placeholder color, the `--mono` variant as `variant="mono"`, and `--invalid` driven by `aria-invalid`).
- `hlm-select` trigger and content: `.k-select`.
- `hlm-label` / field label: `.k-field__label`.
- `hlm-dialog-content` and overlay: `.k-dialog` and `.k-dialog__scrim`. Shadows go only on the floating dialog, per `app/CLAUDE.md`.
- Add primitives: `npx ng g @spartan-ng/cli:ui checkbox` and `npx ng g @spartan-ng/cli:ui toggle-group`. Accept the `libs/ui` directory and add the generated `paths` to `tsconfig.json` the way the existing entries are written. Skin `hlm-checkbox` from `.k-check__box` and the toggle group from `.k-seg` / `.k-seg__opt` / `.k-seg__opt--active`.

Run: `npm run lint && npm run build` → PASS.

- [ ] **Step 4: Write `scripts/check-parity.mjs`**

```js
// Parity gate: capture the Angular build with the same view list as the Svelte
// baseline and fail on any view whose pixels differ by more than 0.1%.
// Local gate only (baseline is Windows-rendered; CI's Linux Chrome differs).
//   npm run check:parity                 all views
//   npm run check:parity -- --only a,b   named views only
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { VIEWS, captureAll } from '../parity/capture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLD = 0.001;
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;

async function serve() {
  const child = spawn('npx', ['ng', 'serve', '--port', '4317', '--configuration', 'production'], { cwd: root, shell: true });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('ng serve did not start in 180s')), 180000);
    child.stdout.on('data', (d) => { if (/Local:\s+http/.test(String(d))) { clearTimeout(t); ok(); } });
    child.on('exit', (c) => fail(new Error(`ng serve exited ${c}`)));
  });
  return child;
}

const actualDir = join(root, 'parity', 'actual');
const diffDir = join(root, 'parity', 'diff');
await rm(actualDir, { recursive: true, force: true });
await mkdir(diffDir, { recursive: true });
if (only) VIEWS.splice(0, VIEWS.length, ...VIEWS.filter((v) => only.has(v.name)));

const server = await serve();
let failed = 0;
try {
  await captureAll('http://localhost:4317', actualDir);
  for (const v of VIEWS) {
    const a = PNG.sync.read(await readFile(join(root, 'parity', 'baseline', `${v.name}.png`)));
    const b = PNG.sync.read(await readFile(join(actualDir, `${v.name}.png`)));
    if (a.width !== b.width || a.height !== b.height) { console.log(`FAIL ${v.name}: size ${b.width}x${b.height} vs ${a.width}x${a.height}`); failed++; continue; }
    const diff = new PNG({ width: a.width, height: a.height });
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const ratio = n / (a.width * a.height);
    if (ratio > THRESHOLD) { failed++; await writeFile(join(diffDir, `${v.name}.png`), PNG.sync.write(diff)); }
    console.log(`${ratio > THRESHOLD ? 'FAIL' : 'ok  '} ${v.name}: ${(ratio * 100).toFixed(3)}%`);
  }
} finally { server.kill(); }
if (failed) { console.error(`\n${failed} view(s) differ; see parity/diff/`); process.exit(1); }
console.log('\nparity: all views match');
```

Add devDependencies `pixelmatch`, `pngjs` and `playwright-core` (same version as `app/package.json`). Add scripts: `"check:parity": "node scripts/check-parity.mjs"`. Confirm that `ng serve` prints `Local:` in this Angular version, and adjust the regex if it doesn't.

- [ ] **Step 5: Desktop-only responsive wrapper**

`scripts/check-responsive-desktop.mjs` imports `assertResponsive` from `../harness/gate/check-responsive.mjs`. It serves the app the same way that file's own CLI block does (read lines 88-105 and copy its serve/teardown), and calls `assertResponsive({ origin, route, breakpoints: [1280, 1600], anchorSelector: 'app-workbench' })` for `''`, then with `app-library` for `library`. Script: `"check:responsive": "node scripts/check-responsive-desktop.mjs"`. Check `check-contrast.mjs` for how it finds its token file (it cites a missing `prototype/capstone-build-spec.md`). If it can't run against `src/styles.css` without an edit to `harness/`, record that in the task report and leave `check:contrast` out of the scripts. Do not edit the harness.

- [ ] **Step 6: Run the parity check and expect failure**

Run: `npm run check:parity -- --only compose-seeded`
Expected: FAIL. The page is still a placeholder. This proves the gate can fail.

- [ ] **Step 7: Commit**

```bash
git add app/web-ng
git commit -m "feat(workbench-ng): sumi-ink theme, skinned helm primitives, parity gate"
```

---

### Task 5: Port the framework-free library code

**Model:** Haiku (mechanical)

**Files:**
- Create: `app/web-ng/src/app/lib/{events,toolcards,spec,kit,katas,scroll,library,mock}.ts`
- Create: `app/web-ng/src/app/lib/{events,toolcards,toolcards.timeout,spec,kit,katas,scroll,library,mock}.spec.ts`

**Interfaces:**
- Produces: the same exports as the Svelte modules, with identical names and signatures. `mock.ts` keeps `inTauri`, `seedCatalog`, `seedSpec`, `ScriptStep`, `runScriptHead`, `runScriptMid`, `runScriptTail`, `PENDING_PERMISSION` and `validateLocal`.

- [ ] **Step 1: Copy the tests first**

Copy each `app/src/lib/<name>.test.ts` to `app/web-ng/src/app/lib/<name>.spec.ts`. In each spec:
- Replace `from "vitest"` imports with nothing; the `vitest/globals` types are on.
- Replace `"$lib/…"` with relative `./…`.
- Replace `"../bindings/X"` with `"@bindings/X"`.

Run: `npm test -- --watch=false`
Expected: FAIL, because the modules are missing.

- [ ] **Step 2: Copy the modules**

Copy `events.ts`, `toolcards.ts`, `spec.ts`, `kit.ts`, `katas.ts`, `scroll.ts`, `library.ts` and `mock.ts` from `app/src/lib/`, applying the same import rewrites. `launch.ts`, `toast.svelte.ts`, `api.ts` and `run.svelte.ts` are not copied (Tasks 6-7 replace them). If any copied module imports one of those, stop and report it.

- [ ] **Step 3: Run the tests**

Run: `npm test -- --watch=false`
Expected: PASS with the same test count the Svelte files had. Count them with `grep -c "^\s*it(" app/src/lib/*.test.ts` versus the Vitest summary. The rest of the suite stays green.

- [ ] **Step 4: Commit**

```bash
git add app/web-ng/src/app/lib
git commit -m "feat(workbench-ng): port framework-free Workbench logic and its tests"
```

---

### Task 6: Transport seam, run store, toast and launch stores

**Model:** Sonnet

**Files:**
- Create: `src/app/core/transport/kata-transport.ts`, `tauri-transport.ts`, `mock-transport.ts`, `provide-kata-transport.ts`, `mock-transport.spec.ts`, `tauri-transport.spec.ts`
- Create: `src/app/core/run/reduce.ts`, `reduce.spec.ts`, `run.store.ts`, `run.store.spec.ts`
- Create: `src/app/core/toast/toast.store.ts`, `toast.store.spec.ts`
- Create: `src/app/core/launch/launch.store.ts`, `launch.store.spec.ts`
- Modify: `src/app/app.config.ts`

**Interfaces:**
- Consumes: `lib/events.ts`, `lib/mock.ts`, `lib/library.ts` (Task 5).
- Produces:
  - `abstract class KataTransport` (methods below)
  - `provideKataTransport(): Provider`
  - `type RunSnapshot`, `type AskRecord`, `const IDLE: RunSnapshot`, `reduce(s: RunSnapshot, ev: KataEvent): RunSnapshot`
  - `class RunStore` with `state`, `events`, `summary`, `asks`, `permissions` (`Signal`s), `startRun(spec)`, `cancelRun()`, `submitAnswer(id, answers)`, `submitDecision(id, allow, message)`
  - `class ToastStore` with `toasts: Signal<Toast[]>`, `error(message): number`, `dismiss(id): void`
  - `class LaunchStore` with `set(p: LaunchPayload)`, `take(): LaunchPayload | null`

- [ ] **Step 1: Write the transport contract**

`kata-transport.ts`:

```ts
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';

/** The one seam between the Workbench and its backend. TauriTransport talks to
 *  the Rust commands; MockTransport stands in with fixtures and a scripted run
 *  in a plain browser. Nothing above this class knows which one it has. The
 *  event hook is callback + unlisten on purpose: no Observable crosses the seam,
 *  so nothing above it can subscribe. */
export abstract class KataTransport {
  abstract catalog(workdir: string | null): Promise<CatalogEntry[]>;
  abstract listRuns(): Promise<RunRecord[]>;
  abstract loadRun(id: string): Promise<RunDetail>;
  abstract loadSpec(path: string): Promise<RunSpec>;
  abstract saveSpec(path: string, spec: RunSpec): Promise<void>;
  abstract validateSpec(spec: RunSpec): Promise<string[]>;
  abstract runSpec(spec: RunSpec): Promise<void>;
  abstract cancelRun(): Promise<void>;
  abstract submitAnswer(id: string, answers: string[][]): Promise<void>;
  abstract submitDecision(id: string, allow: boolean, message: string | null): Promise<void>;
  abstract listKatas(): Promise<KataListing>;
  abstract loadKata(name: string): Promise<RunSpec>;
  abstract saveKata(spec: RunSpec): Promise<void>;
  abstract listPresets(): Promise<Preset[]>;
  abstract savePreset(name: string, body: string): Promise<void>;
  abstract exportBundle(spec: RunSpec, out: string): Promise<void>;
  abstract pickDirectory(): Promise<string | null>;
  abstract pickOpenSpec(): Promise<string | null>;
  abstract pickSaveSpec(): Promise<string | null>;
  /** Register for relayed run events. Resolves to the unlisten function. */
  abstract onRunEvent(cb: (ev: KataEvent) => void): Promise<() => void>;
}

export const NO_BACKEND = 'this action needs the Kata desktop app (Tauri backend unavailable)';
```

- [ ] **Step 2: Write the failing MockTransport tests**

`mock-transport.spec.ts`:

```ts
import { MockTransport } from './mock-transport';
import { NO_BACKEND } from './kata-transport';
import { runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';

const total = (steps: { delay: number }[]) => steps.reduce((a, s) => a + s.delay, 0);

describe('MockTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays the head of the scripted run after runSpec', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.runSpec(seedSpec());
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual(runScriptHead.map((s) => s.ev));
  });

  it('emits ask.answered then plays the middle on submitAnswer', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.submitAnswer('q1', [['yes']]);
    expect(seen[0]).toEqual({ type: 'ask.answered', id: 'q1', answers: [['yes']] });
    vi.advanceTimersByTime(total(runScriptMid));
    expect(seen.slice(1)).toEqual(runScriptMid.map((s) => s.ev));
  });

  it('emits the operator decision then plays the tail on submitDecision', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.submitDecision('p1', false, 'no');
    expect(seen[0]).toEqual({ type: 'permission.decided', id: 'p1', ...PENDING_PERMISSION, allow: false, decided_by: 'operator', message: 'no' });
    vi.advanceTimersByTime(total(runScriptTail));
    expect(seen.length).toBe(1 + runScriptTail.length);
  });

  it('stops the scripted stream on cancelRun', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    await t.onRunEvent((e) => seen.push(e));
    await t.runSpec(seedSpec());
    await t.cancelRun();
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual([]);
  });

  it('stops delivering after unlisten', async () => {
    const t = new MockTransport();
    const seen: KataEvent[] = [];
    const off = await t.onRunEvent((e) => seen.push(e));
    off();
    await t.runSpec(seedSpec());
    vi.advanceTimersByTime(total(runScriptHead));
    expect(seen).toEqual([]);
  });

  it('rejects backend-only calls with NO_BACKEND', async () => {
    const t = new MockTransport();
    await expect(t.loadSpec('x.toml')).rejects.toThrow(NO_BACKEND);
    await expect(t.saveSpec('x.toml', seedSpec())).rejects.toThrow(NO_BACKEND);
    await expect(t.exportBundle(seedSpec(), 'out')).rejects.toThrow(NO_BACKEND);
  });

  it('resolves pickers to null', async () => {
    const t = new MockTransport();
    expect(await t.pickDirectory()).toBeNull();
    expect(await t.pickOpenSpec()).toBeNull();
    expect(await t.pickSaveSpec()).toBeNull();
  });
});
```

Run: `npm test -- --watch=false` → FAIL (module missing).

- [ ] **Step 3: Implement MockTransport**

Port the browser branches of `app/src/lib/api.ts` into a class. The module-level `browserCb`/`browserTimers` become instance fields:

```ts
import type { RunSpec } from '@bindings/RunSpec';
import type { CatalogEntry } from '@bindings/CatalogEntry';
import type { Preset } from '@bindings/Preset';
import type { KataListing } from '@bindings/KataListing';
import type { KataEvent, RunRecord, RunDetail } from '../../lib/events';
import { seedCatalog, validateLocal, runScriptHead, runScriptMid, runScriptTail, PENDING_PERMISSION, type ScriptStep } from '../../lib/mock';
import { history, runDetailFixture, katasFixture, presetsFixture } from '../../lib/library';
import { KataTransport, NO_BACKEND } from './kata-transport';

/** Browser stand-in: fixtures plus the scripted run timeline (head → ask →
 *  mid → permission → tail), unblocked by submitAnswer / submitDecision. */
export class MockTransport extends KataTransport {
  private cb: ((ev: KataEvent) => void) | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];

  private play(segment: ScriptStep[]): void {
    let acc = 0;
    for (const step of segment) {
      acc += step.delay;
      this.timers.push(setTimeout(() => this.cb?.(step.ev), acc));
    }
  }

  catalog = (_workdir: string | null): Promise<CatalogEntry[]> => Promise.resolve(seedCatalog);
  listRuns = (): Promise<RunRecord[]> => Promise.resolve(history);
  loadRun = (id: string): Promise<RunDetail> => Promise.resolve(runDetailFixture(id));
  loadSpec = (_path: string): Promise<RunSpec> => Promise.reject(new Error(NO_BACKEND));
  saveSpec = (_path: string, _spec: RunSpec): Promise<void> => Promise.reject(new Error(NO_BACKEND));
  validateSpec = (spec: RunSpec): Promise<string[]> => Promise.resolve(validateLocal(spec));
  listKatas = (): Promise<KataListing> => Promise.resolve({ katas: katasFixture, failures: [] });
  loadKata = (name: string): Promise<RunSpec> => Promise.resolve(katasFixture.find((k) => k.name === name) ?? katasFixture[0]);
  saveKata = (_spec: RunSpec): Promise<void> => Promise.resolve();
  listPresets = (): Promise<Preset[]> => Promise.resolve(presetsFixture);
  savePreset = (_name: string, _body: string): Promise<void> => Promise.resolve();
  exportBundle = (_spec: RunSpec, _out: string): Promise<void> => Promise.reject(new Error(NO_BACKEND));
  pickDirectory = (): Promise<string | null> => Promise.resolve(null);
  pickOpenSpec = (): Promise<string | null> => Promise.resolve(null);
  pickSaveSpec = (): Promise<string | null> => Promise.resolve(null);

  async onRunEvent(cb: (ev: KataEvent) => void): Promise<() => void> {
    this.cb = cb;
    return () => { if (this.cb === cb) this.cb = null; };
  }
  async runSpec(_spec: RunSpec): Promise<void> { this.play(runScriptHead); }
  async cancelRun(): Promise<void> { this.timers.forEach(clearTimeout); this.timers = []; }
  async submitAnswer(id: string, answers: string[][]): Promise<void> {
    this.cb?.({ type: 'ask.answered', id, answers });
    this.play(runScriptMid);
  }
  async submitDecision(id: string, allow: boolean, message: string | null): Promise<void> {
    this.cb?.({ type: 'permission.decided', id, ...PENDING_PERMISSION, allow, decided_by: 'operator', message: message ?? undefined });
    this.play(runScriptTail);
  }
}
```

If TypeScript rejects arrow-function properties overriding abstract methods, write them as methods instead; the behavior is identical. Check the `library.ts` export names against `app/src/lib/library.ts` (`history` is imported there as `historyFixture`). Run: PASS.

- [ ] **Step 4: Write the failing TauriTransport test, then implement it**

`tauri-transport.ts` takes its IPC functions as a constructor argument, so tests need no module mocking:

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
// ...binding + event type imports as in kata-transport.ts

export interface TauriIpc {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: (e: { payload: T }) => void) => Promise<() => void>;
  open: (opts: Record<string, unknown>) => Promise<unknown>;
  save: (opts: Record<string, unknown>) => Promise<unknown>;
}
const realIpc: TauriIpc = { invoke, listen, open: open as TauriIpc['open'], save: save as TauriIpc['save'] };
const SPEC_FILTERS = [{ name: 'Run-spec', extensions: ['toml', 'json'] }];

export class TauriTransport extends KataTransport {
  constructor(private readonly ipc: TauriIpc = realIpc) { super(); }
  catalog(workdir: string | null) { return this.ipc.invoke<CatalogEntry[]>('catalog', { workdir }); }
  listRuns() { return this.ipc.invoke<RunRecord[]>('list_runs'); }
  loadRun(id: string) { return this.ipc.invoke<RunDetail>('load_run', { id }); }
  loadSpec(path: string) { return this.ipc.invoke<RunSpec>('load_spec', { path }); }
  saveSpec(path: string, spec: RunSpec) { return this.ipc.invoke<void>('save_spec', { path, spec }); }
  validateSpec(spec: RunSpec) { return this.ipc.invoke<string[]>('validate_spec', { spec }); }
  runSpec(spec: RunSpec) { return this.ipc.invoke<void>('run_spec', { spec }); }
  cancelRun() { return this.ipc.invoke<void>('cancel_run'); }
  submitAnswer(id: string, answers: string[][]) { return this.ipc.invoke<void>('submit_answer', { id, answers }); }
  submitDecision(id: string, allow: boolean, message: string | null) { return this.ipc.invoke<void>('submit_decision', { id, allow, message }); }
  listKatas() { return this.ipc.invoke<KataListing>('list_katas'); }
  loadKata(name: string) { return this.ipc.invoke<RunSpec>('load_kata', { name }); }
  saveKata(spec: RunSpec) { return this.ipc.invoke<void>('save_kata', { spec }); }
  listPresets() { return this.ipc.invoke<Preset[]>('list_presets'); }
  savePreset(name: string, body: string) { return this.ipc.invoke<void>('save_preset', { name, body }); }
  exportBundle(spec: RunSpec, out: string) { return this.ipc.invoke<void>('export_bundle', { spec, out }); }
  pickDirectory() { return this.ipc.open({ directory: true, multiple: false }) as Promise<string | null>; }
  pickOpenSpec() { return this.ipc.open({ multiple: false, filters: SPEC_FILTERS }) as Promise<string | null>; }
  pickSaveSpec() { return this.ipc.save({ filters: SPEC_FILTERS }) as Promise<string | null>; }
  onRunEvent(cb: (ev: KataEvent) => void) { return this.ipc.listen<KataEvent>('kata://event', (e) => cb(e.payload)); }
}
```

`tauri-transport.spec.ts` builds a fake `TauriIpc` with `vi.fn()`s. It asserts the exact command name and argument object for all 16 `invoke` methods (one table-driven `it.each` over `[method, args, cmd, payload]` rows copied from `app/src/lib/api.ts`), and asserts that `onRunEvent` forwards `e.payload` from a `kata://event` listener. Write the spec first (FAIL), then the class (PASS).

- [ ] **Step 5: Write the failing reduce tests**

Port every state-transition assertion in `app/src/lib/run.test.ts` to `reduce.spec.ts` as pure input → output checks, and add:

```ts
import { reduce, IDLE, type RunSnapshot } from './reduce';

const running: RunSnapshot = { ...IDLE, state: 'running' };

it('does not mutate the input snapshot', () => {
  const before = structuredClone(running);
  reduce(running, { type: 'log', level: 'info', message: 'x' });
  expect(running).toEqual(before);
});

it('returns a new events array when a row is appended', () => {
  const next = reduce(running, { type: 'log', level: 'info', message: 'x' });
  expect(next.events).not.toBe(running.events);
  expect(next.events).toHaveLength(1);
});

it('stamps an ask with the number of rows before it', () => {
  const withRow = reduce(running, { type: 'log', level: 'info', message: 'x' });
  const next = reduce(withRow, { type: 'ask.requested', id: 'a', questions: [] });
  expect(next.asks[0].at).toBe(1);
  expect(next.state).toBe('awaiting');
});

it('pushes a permission.decided with no open card into the stream', () => {
  const ev = { type: 'permission.decided', id: 'p', tool: 'Bash', input_summary: 'ls', allow: true, decided_by: 'rule' } as const;
  const next = reduce(running, ev);
  expect(next.events).toEqual([ev]);
  expect(next.state).toBe('running');
});

it('settles run.completed with exit 0 as success and keeps the summary', () => {
  const ev = { type: 'run.completed', exit_code: 0 } as never;
  const next = reduce(running, ev);
  expect(next.state).toBe('success');
  expect(next.summary).toBe(ev);
});
```

Fill in the required fields of each event object from the generated `@bindings/kata-events` types (the test must type-check). Run: FAIL.

- [ ] **Step 6: Implement `reduce.ts`**

```ts
import type { KataEvent, StreamEvent, RunSummary, RunState, Question, PermissionRecord } from '../../lib/events';
import { terminalStateFor } from '../../lib/events';

export type AskRecord = {
  id: string;
  questions: Question[];
  answers: string[][] | null;
  /** How many stream rows preceded this ask, so the Observe pane renders it where it happened. */
  at: number;
};

export type RunSnapshot = {
  state: RunState;
  events: StreamEvent[];
  summary: RunSummary | null;
  asks: AskRecord[];
  permissions: PermissionRecord[];
};

export const IDLE: RunSnapshot = { state: 'idle', events: [], summary: null, asks: [], permissions: [] };

/** The Observe pane's state machine as a pure function. Always returns new
 *  arrays rather than mutating, because a signal only notifies on a new reference. */
export function reduce(s: RunSnapshot, ev: KataEvent): RunSnapshot {
  switch (ev.type) {
    case 'run.started':
    case 'run.diff':
      return s;
    case 'ask.requested':
      return { ...s, state: 'awaiting', asks: [...s.asks, { id: ev.id, questions: ev.questions, answers: null, at: s.events.length }] };
    case 'ask.answered':
      return { ...s, state: 'running', asks: s.asks.map((a) => (a.id === ev.id ? { ...a, answers: ev.answers } : a)) };
    case 'permission.requested':
      return {
        ...s,
        state: 'awaiting',
        permissions: [...s.permissions, { id: ev.id, tool: ev.tool, input_summary: ev.input_summary, decided: null, at: s.events.length }],
      };
    case 'permission.decided':
      // A check that opened a card resolves it; one settled by a rule or the
      // unmatched policy never paused the run, so it lands in the stream.
      if (!s.permissions.some((p) => p.id === ev.id)) return { ...s, events: [...s.events, ev] };
      return {
        ...s,
        state: 'running',
        permissions: s.permissions.map((p) => (p.id === ev.id ? { ...p, decided: { allow: ev.allow, message: ev.message ?? null } } : p)),
      };
    case 'run.completed':
      return settle({ ...s, summary: ev }, ev);
    case 'run.error':
      return settle({ ...s, events: [...s.events, { type: 'log', level: 'error', message: ev.message }] }, ev);
    case 'run.cancelled':
      return settle(s, ev);
    default:
      return { ...s, events: [...s.events, ev] };
  }
}

function settle(s: RunSnapshot, ev: KataEvent): RunSnapshot {
  const terminal = terminalStateFor(ev);
  return terminal ? { ...s, state: terminal } : s;
}
```

Run: PASS.

- [ ] **Step 7: Write the failing RunStore tests**

`run.store.spec.ts` uses a fake transport through DI:

```ts
import { TestBed } from '@angular/core/testing';
import { RunStore } from './run.store';
import { KataTransport } from '../transport/kata-transport';
import { seedSpec } from '../../lib/mock';
import type { KataEvent } from '../../lib/events';

class FakeTransport {
  listeners: ((ev: KataEvent) => void)[] = [];
  unlistened = 0;
  runSpec = vi.fn(() => Promise.resolve());
  cancelRun = vi.fn(() => Promise.resolve());
  submitAnswer = vi.fn(() => Promise.resolve());
  submitDecision = vi.fn(() => Promise.resolve());
  onRunEvent(cb: (ev: KataEvent) => void) {
    this.listeners.push(cb);
    return Promise.resolve(() => { this.unlistened++; });
  }
}

function setup() {
  const fake = new FakeTransport();
  TestBed.configureTestingModule({ providers: [{ provide: KataTransport, useValue: fake }] });
  return { store: TestBed.inject(RunStore), fake };
}
const log = (message: string): KataEvent => ({ type: 'log', level: 'info', message });

describe('RunStore', () => {
  it('starts running and appends streamed rows', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    expect(store.state()).toBe('running');
    fake.listeners[0](log('hello'));
    expect(store.events()).toEqual([log('hello')]);
  });

  it('ignores startRun while a run is active', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    await store.startRun(seedSpec());
    expect(fake.runSpec).toHaveBeenCalledTimes(1);
  });

  it('drops an event from a cancelled run that arrives after a re-run', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    const stale = fake.listeners[0];
    await store.cancelRun();
    await store.startRun(seedSpec());
    stale(log('late from run 1'));
    expect(store.events()).toEqual([]);
    fake.listeners[1](log('run 2'));
    expect(store.events()).toEqual([log('run 2')]);
  });

  it('drops events after a terminal event and unlistens', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    fake.listeners[0]({ type: 'run.completed', exit_code: 0 } as never);
    expect(store.state()).toBe('success');
    expect(fake.unlistened).toBe(1);
    fake.listeners[0](log('after the end'));
    expect(store.events()).toEqual([]);
  });

  it('marks cancel as a warning with the cleanup log row', async () => {
    const { store } = setup();
    await store.startRun(seedSpec());
    await store.cancelRun();
    expect(store.state()).toBe('warning');
    expect(store.events().at(-1)).toEqual({ type: 'log', level: 'warn', message: 'run cancelled — engine stopped claude and cleaned up the plugin-dir' });
  });

  it('shows a failed runSpec as an error row', async () => {
    const { store, fake } = setup();
    fake.runSpec.mockRejectedValueOnce('boom');
    await store.startRun(seedSpec());
    expect(store.state()).toBe('error');
    expect(store.events().at(-1)).toEqual({ type: 'log', level: 'error', message: 'run failed: boom' });
  });

  it('forwards answers and decisions only while awaiting', async () => {
    const { store, fake } = setup();
    await store.startRun(seedSpec());
    await store.submitAnswer('a', [['x']]);
    expect(fake.submitAnswer).not.toHaveBeenCalled();
    fake.listeners[0]({ type: 'ask.requested', id: 'a', questions: [] });
    await store.submitAnswer('a', [['x']]);
    expect(fake.submitAnswer).toHaveBeenCalledWith('a', [['x']]);
  });
});
```

Also port any `run.test.ts` case not already covered by `reduce.spec.ts`. Run: FAIL.

- [ ] **Step 8: Implement `run.store.ts`**

```ts
import { Injectable, computed, inject, signal } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';
import type { KataEvent } from '../../lib/events';
import { terminalStateFor } from '../../lib/events';
import { KataTransport } from '../transport/kata-transport';
import { IDLE, reduce, type RunSnapshot } from './reduce';

/** Drives a run through the transport and holds the Observe pane's state. Each
 *  run gets a generation number; an event whose generation is no longer current
 *  (a late delivery after Cancel, a terminal event, or a fast Re-run) is dropped. */
@Injectable({ providedIn: 'root' })
export class RunStore {
  private readonly transport = inject(KataTransport);
  private readonly snap = signal<RunSnapshot>(IDLE);
  private generation = 0;
  private unlisten: (() => void) | null = null;

  readonly state = computed(() => this.snap().state);
  readonly events = computed(() => this.snap().events);
  readonly summary = computed(() => this.snap().summary);
  readonly asks = computed(() => this.snap().asks);
  readonly permissions = computed(() => this.snap().permissions);

  private active(): boolean {
    const s = this.snap().state;
    return s === 'running' || s === 'awaiting';
  }

  private teardown(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  private append(level: 'warn' | 'error', message: string): void {
    this.snap.update((s) => ({ ...s, events: [...s.events, { type: 'log', level, message }] }));
  }

  private receive(gen: number, ev: KataEvent): void {
    if (gen !== this.generation) return;
    this.snap.update((s) => reduce(s, ev));
    if (terminalStateFor(ev)) {
      this.generation++;
      this.teardown();
    }
  }

  async startRun(spec: RunSpec): Promise<void> {
    if (this.active()) return;
    this.teardown();
    const gen = ++this.generation;
    this.snap.set({ ...IDLE, state: 'running' });
    const unlisten = await this.transport.onRunEvent((ev) => this.receive(gen, ev));
    if (gen !== this.generation) {
      unlisten();
      return;
    }
    this.unlisten = unlisten;
    try {
      await this.transport.runSpec(spec);
    } catch (e) {
      if (gen !== this.generation) return;
      this.generation++;
      this.append('error', `run failed: ${e}`);
      this.snap.update((s) => ({ ...s, state: 'error' }));
      this.teardown();
    }
  }

  async cancelRun(): Promise<void> {
    if (!this.active()) return;
    await this.transport.cancelRun();
    this.generation++;
    this.append('warn', 'run cancelled — engine stopped claude and cleaned up the plugin-dir');
    this.snap.update((s) => ({ ...s, state: 'warning' }));
    this.teardown();
  }

  async submitAnswer(id: string, answers: string[][]): Promise<void> {
    if (this.snap().state !== 'awaiting') return;
    await this.transport.submitAnswer(id, answers);
  }

  async submitDecision(id: string, allow: boolean, message: string | null): Promise<void> {
    if (this.snap().state !== 'awaiting') return;
    await this.transport.submitDecision(id, allow, message);
  }
}
```

Run: PASS.

- [ ] **Step 9: Toast and launch stores (test first)**

Port `app/src/lib/toast.test.ts` to `toast.store.spec.ts` (`TestBed.inject(ToastStore)`; `toastError(m)` → `store.error(m)`; `toasts()` → `store.toasts()`; `dismiss` is unchanged). Port `launch.test.ts` to `launch.store.spec.ts` (`setLaunch` → `store.set`, `takeLaunch` → `store.take`). Run: FAIL. Then implement:

```ts
// toast.store.ts
import { Injectable, signal } from '@angular/core';

export type Toast = { id: number; kind: 'error'; message: string };
const TTL_MS = 6000;

/** Transient error notifications, rendered by the Toaster in the app shell. */
@Injectable({ providedIn: 'root' })
export class ToastStore {
  private readonly items = signal<Toast[]>([]);
  private seq = 0;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly toasts = this.items.asReadonly();

  error(message: string): number {
    const id = ++this.seq;
    this.items.update((xs) => [...xs, { id, kind: 'error', message }]);
    this.timers.set(id, setTimeout(() => this.dismiss(id), TTL_MS));
    return id;
  }

  /** Remove a toast and clear its timer. An unknown id is a no-op (no signal write). */
  dismiss(id: number): void {
    const t = this.timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    if (this.items().some((x) => x.id === id)) this.items.update((xs) => xs.filter((x) => x.id !== id));
  }
}
```

```ts
// launch.store.ts
import { Injectable } from '@angular/core';
import type { RunSpec } from '@bindings/RunSpec';

export type LaunchPayload = { spec: RunSpec; autorun: boolean };

/** One-shot handoff from the Library to Compose: set just before navigating,
 *  taken once when the Workbench screen initializes. Not reactive on purpose. */
@Injectable({ providedIn: 'root' })
export class LaunchStore {
  private pending: LaunchPayload | null = null;
  set(payload: LaunchPayload): void { this.pending = payload; }
  take(): LaunchPayload | null { const v = this.pending; this.pending = null; return v; }
}
```

Run: PASS.

- [ ] **Step 10: Provide the transport**

`provide-kata-transport.ts`:

```ts
import { Provider } from '@angular/core';
import { inTauri } from '../../lib/mock';
import { KataTransport } from './kata-transport';
import { MockTransport } from './mock-transport';
import { TauriTransport } from './tauri-transport';

/** Pick the backend once, at bootstrap. */
export function provideKataTransport(): Provider {
  return { provide: KataTransport, useFactory: () => (inTauri() ? new TauriTransport() : new MockTransport()) };
}
```

Add `provideKataTransport()` to `app.config.ts` providers. Run: `npm test -- --watch=false && npm run lint && npm run build` → PASS.

- [ ] **Step 11: Commit**

```bash
git add app/web-ng/src/app/core app/web-ng/src/app/app.config.ts
git commit -m "feat(workbench-ng): transport seam, signal run store with generation guard, toast and launch stores"
```

---

### Task 7: Leaf presentational components

**Model:** Sonnet

**Files:**
- Create in `src/app/ui/`: `summary-stat.ts`, `field.ts`, `segmented.ts`, `validation-banner.ts`, `toaster.ts`
- Create: `src/app/app-shell.view-model.ts`; modify `src/app/app.ts`

**Interfaces:**
- Consumes: Task 4 primitives, Task 6 `ToastStore`.
- Produces:
  - `SummaryStat` (inputs as in `SummaryStat.svelte`)
  - `Field` (content projection replaces the snippet: `<app-field label="…" hint="…"><input hlmInput /></app-field>`)
  - `Segmented<T>`: `options = input.required<{ value: T; label: string }[]>()`, `value = model.required<T>()`, rendered with `hlm-toggle-group`
  - `ValidationBanner`: `errors = input.required<string[]>()`
  - `Toaster`: `toasts = input.required<Toast[]>()`, `dismiss = output<number>()`
  - `AppShellViewModel`: `toasts`, `dismiss(id)`

- [ ] **Step 1: Write the failing tests**

There were no Svelte tests for these components, so write one behavior test each, in `src/app/ui/<name>.spec.ts`, using `render` from `src/testing/render.ts`:

```ts
// validation-banner.spec.ts
import { render } from '../../testing/render';
import { ValidationBanner } from './validation-banner';

describe('ValidationBanner', () => {
  it('renders nothing for no errors', async () => {
    const { container } = await render(ValidationBanner, { errors: [] });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it('lists each error in an alert', async () => {
    const { container } = await render(ValidationBanner, { errors: ['task is required', 'bad rule'] });
    const alert = container.querySelector('.wb-banner--error[role="alert"]')!;
    expect(alert.textContent).toContain('task is required');
    expect(alert.textContent).toContain('bad rule');
  });
});
```

```ts
// segmented.spec.ts
import { render } from '../../testing/render';
import { Segmented } from './segmented';

describe('Segmented', () => {
  it('marks the current value and writes the clicked one back', async () => {
    const { container, fixture } = await render(Segmented, {
      options: [{ value: 'append', label: 'Append' }, { value: 'replace', label: 'Replace' }],
      value: 'append',
    });
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons[0].getAttribute('aria-pressed') ?? buttons[0].getAttribute('data-state')).toMatch(/true|on/);
    buttons[1].click();
    await fixture.whenStable();
    expect(fixture.componentInstance.value()).toBe('replace');
  });
});
```

```ts
// toaster.spec.ts
import { render } from '../../testing/render';
import { Toaster } from './toaster';

describe('Toaster', () => {
  it('renders each toast and emits dismiss with its id', async () => {
    const { container, fixture } = await render(Toaster, { toasts: [{ id: 7, kind: 'error', message: 'save failed' }] });
    expect(container.textContent).toContain('save failed');
    const spy = vi.fn();
    fixture.componentInstance.dismiss.subscribe(spy);
    (container.querySelector('button') as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalledWith(7);
  });
});
```

(`.subscribe` on an `OutputEmitterRef` in a spec file is outside every component and ViewModel, so the shape rule doesn't apply.) Add `summary-stat.spec.ts` and `field.spec.ts` asserting their label/value text renders. Run: FAIL.

- [ ] **Step 2: Port the components**

Port each Svelte file using the conversion rules, keeping its classes (`wb-banner`, `k-stat`, …) and DOM structure so the global CSS still applies. Then create `app-shell.view-model.ts`:

```ts
import { Injectable, inject } from '@angular/core';
import { ToastStore } from './core/toast/toast.store';

@Injectable()
export class AppShellViewModel {
  private readonly toastStore = inject(ToastStore);
  readonly toasts = this.toastStore.toasts;
  dismiss(id: number): void { this.toastStore.dismiss(id); }
}
```

`app.ts` provides it and renders `<router-outlet /><app-toaster [toasts]="vm.toasts()" (dismiss)="vm.dismiss($event)" />`. Run: PASS, plus `npm run lint`.

- [ ] **Step 3: Commit**

```bash
git add app/web-ng/src/app
git commit -m "feat(workbench-ng): summary stat, field, segmented, validation banner, toaster"
```

---

### Task 8: Event rows, markdown and tool cards

**Model:** Sonnet

**Files:**
- Create in `src/app/ui/`: `markdown-body.ts`, `event-row.ts`, `tool-card.ts`, `diff-body.ts`, `todo-body.ts`, `output-body.ts`, `json-body.ts`, `render-markdown.ts`
- Tests: `markdown-body.spec.ts`, `event-row.spec.ts`, `tool-card.spec.ts`, `diff-body.spec.ts`, `render-markdown.spec.ts`

**Interfaces:**
- Consumes: `lib/events.ts`, `lib/toolcards.ts`.
- Produces:
  - `renderMarkdown(md: string): string` (sanitized HTML)
  - `MarkdownBody`: `md = input.required<string>()`
  - `EventRow`: `ev = input.required<StreamEvent>()`
  - `ToolCard`: `call = input.required<ToolCall>()`, recursive for nested calls
  - `DiffBody`: `oldText`, `newText`
  - `TodoBody`: `todos`
  - `OutputBody`: `text`, `truncated = false`
  - `JsonBody`: `value`

- [ ] **Step 1: Write the failing markdown tests**

`render-markdown.spec.ts`:

```ts
import { renderMarkdown } from './render-markdown';

describe('renderMarkdown', () => {
  it('renders GFM: strong, tables, task lists, strikethrough', () => {
    const html = renderMarkdown('**a** ~~b~~\n\n| x |\n|---|\n| 1 |\n\n- [x] done');
    expect(html).toContain('<strong>a</strong>');
    expect(html).toContain('<del>b</del>');
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
  });

  it('never renders raw HTML from the model', () => {
    const html = renderMarkdown('hi <img src=x onerror=alert(1)> <script>alert(2)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('drops javascript: link targets', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:');
  });
});
```

Port every case in `app/src/lib/components/MarkdownBody.test.ts` to `markdown-body.spec.ts` using `render`. Run: FAIL.

- [ ] **Step 2: Implement the markdown pipeline**

```ts
// render-markdown.ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

/** The same remark + GFM parse svelte-exmarkdown used, sanitized and serialized
 *  to HTML. Raw HTML in the source is dropped (remark-rehype ignores it unless
 *  allowDangerousHtml is set), and rehype-sanitize applies GitHub's schema to
 *  whatever remains. */
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSanitize).use(rehypeStringify);

export function renderMarkdown(md: string): string {
  return String(processor.processSync(md));
}
```

`MarkdownBody` binds `<div class="k-md" [innerHTML]="html()" (click)="onClick($event)"></div>` with `html = computed(() => renderMarkdown(this.md()))`. Angular's built-in sanitizer runs on top of this; don't use `bypassSecurityTrustHtml`. Port `handleClick` from `MarkdownBody.svelte` verbatim into `onClick`. If it opens links through Tauri, it needs `inTauri()` from `lib/mock.ts`, which is a plain function, not an injection, so `no-presentational-inject` allows it. Compare the GFM output against `svelte-exmarkdown` for the same input by running the old Svelte test fixtures. A visible difference (for example task-list checkbox markup) gets CSS in `components.css`, not a different parser. Run: PASS.

- [ ] **Step 3: Port EventRow, ToolCard and the bodies (tests first)**

Port `EventRow.test.ts`, `ToolCard.test.ts` and `toolcards/DiffBody.test.ts` to specs with `render`, keeping every assertion. Run: FAIL. Then port the components. Notes:
- EventRow's turn divider `style="display:block;border-top:1px dashed var(--border-subtle);margin-top:6px"` becomes class `k-event__turn-rule` in `components.css`. Use `margin-top: var(--space-…)`; check which `--space-*` token is 6px, and add `--space-1-5: 6px` if none is.
- ToolCard's `toggled = $state<boolean|null>(null)` becomes `signal<boolean | null>(null)`, and `open = computed(() => this.toggled() ?? defaultOpen(this.call()))`. Recursion: `ToolCard` lists itself in `imports` via `forwardRef(() => ToolCard)`.
- TodoBody's icons are `lucideCheck`, `lucideCircleDot` and `lucideCircle`, each registered with `provideIcons` in that component.

Run: PASS, then `npm run lint`.

- [ ] **Step 4: Commit**

```bash
git add app/web-ng/src/app/ui app/web-ng/src/styles/kata/components.css app/web-ng/src/styles/kata/tokens
git commit -m "feat(workbench-ng): event rows, sanitized markdown, tool cards"
```

---

### Task 9: Ask and permission panels

**Model:** Sonnet

**Files:**
- Create: `src/app/ui/ask-panel.ts`, `ask-panel.spec.ts`, `permission-panel.ts`, `permission-panel.spec.ts`

**Interfaces:**
- Consumes: `AskRecord` (Task 6), `PermissionRecord` (`lib/events.ts`).
- Produces: `AskPanel` (`ask = input.required<AskRecord>()`, `answer = output<{ id: string; answers: string[][] }>()`, plus any other Svelte props, converted by the rules) and `PermissionPanel` (`record = input.required<PermissionRecord>()`, `decide = output<{ id: string; allow: boolean; message: string | null }>()`). Read the exact prop names in `AskPanel.svelte` and `PermissionPanel.svelte` before naming the inputs, and keep the names.

- [ ] **Step 1: Port the tests**

Port `AskPanel.test.ts` and `PermissionPanel.test.ts` to specs with `render`. Each callback-prop assertion becomes an output assertion via `fixture.componentInstance.<output>.subscribe(spy)`. Run: FAIL.

- [ ] **Step 2: Port the components**

Option buttons are `hlmBtn` with the variant that matches their current `.k-btn--*` class. The free-text answer is `hlmTextarea`. The "Other" answer on every select question (from #43) must be ported. The button labels (`Allow · resume` and the rest) stay byte-identical, because Task 1's parity script clicks them by name. Run: PASS, then lint.

- [ ] **Step 3: Commit**

```bash
git add app/web-ng/src/app/ui
git commit -m "feat(workbench-ng): ask and permission panels"
```

---

### Task 10: Observe pane

**Model:** Sonnet

**Files:**
- Create: `src/app/ui/observe-pane.ts`, `observe-pane.spec.ts`

**Interfaces:**
- Consumes: EventRow, ToolCard, SummaryStat, AskPanel, PermissionPanel, MarkdownBody; `lib/toolcards.ts` pairing; `lib/scroll.ts` `isAtBottom`.
- Produces: `ObservePane` with inputs `state`, `events`, `summary`, `asks`, `permissions` (plus any spec-derived badges that `ObservePane.svelte` takes as props) and outputs `answer`, `decide`, `cancel` (matching the Svelte callback props).

- [ ] **Step 1: Port `ObservePane.test.ts`** to `observe-pane.spec.ts` with `render`. Run: FAIL.
- [ ] **Step 2: Port the component.** Ask and permission cards are spliced back in at their `at` index exactly as the Svelte template does. Auto-scroll behavior: if the Svelte file uses `$effect` + `isAtBottom` to stick to the bottom, port it as an `effect()` that reads `events()` and scrolls a `viewChild` element. That is a real DOM side effect, which the conversion rules allow. Run: PASS, then lint.
- [ ] **Step 3: Commit**

```bash
git add app/web-ng/src/app/ui
git commit -m "feat(workbench-ng): observe pane"
```

---

### Task 11: Compose pane, kit checklist, prompt dialog

**Model:** Sonnet

**Files:**
- Create: `src/app/ui/compose-pane.ts`, `compose-pane.spec.ts`, `kit-checklist.ts`, `kit-checklist.spec.ts`, `prompt-dialog.ts`, `prompt-dialog.spec.ts`

**Interfaces:**
- Consumes: Field, Segmented, primitives; `lib/spec.ts` (`modelChoiceFor`, `modelIdForChoice`), `lib/kit.ts`.
- Produces: `ComposePane` with `form = input.required<FieldTree<RunSpec>>()` (Signal Forms field tree owned by `WorkbenchViewModel`, Task 13), `catalog = input.required<CatalogEntry[]>()`, `presets = input.required<Preset[]>()`, and outputs for every callback prop in `ComposePane.svelte` (browse workdir, save preset, apply preset, …). `KitChecklist` with `spec = input.required<RunSpec>()`, `entries = input.required<CatalogEntry[]>()`, `specChange = output<RunSpec>()`. `PromptDialog` with `open`, `title`, `confirm = output<string>()`, `cancel = output<void>()`.

- [ ] **Step 1: Write the failing number-field test (Review Focus #1)**

```ts
// compose-pane.spec.ts (first test)
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { form } from '@angular/forms/signals';
import { render } from '../../testing/render';
import { ComposePane } from './compose-pane';
import { seedSpec, seedCatalog } from '../lib/mock';
import type { RunSpec } from '@bindings/RunSpec';

async function mount(spec: RunSpec) {
  const model = signal(spec);
  const tree = TestBed.runInInjectionContext(() => form(model));
  const r = await render(ComposePane, { form: tree, catalog: seedCatalog, presets: [] });
  return { ...r, model };
}

it('stores null, not 0 or NaN, when a number field is emptied', async () => {
  const { container, fixture, model } = await mount(seedSpec());
  const turns = container.querySelector('input[name="max_turns"], #max-turns') as HTMLInputElement;
  turns.value = '';
  turns.dispatchEvent(new Event('input'));
  await fixture.whenStable();
  expect(model().leash.max_turns).toBeNull();
});
```

Adjust the selector to whatever id/name the ported input uses, and repeat the assertion for `timeout_secs`, `max_budget_usd` and `interactive.answer_timeout_secs`. Run: FAIL.

- [ ] **Step 2: Port the rest of `ComposePane.test.ts`**

The Svelte test used `spec-fixture.svelte.ts` for a reactive spec. The `mount` helper above replaces it: assertions on the mutated spec read `model()`. Run: FAIL.

- [ ] **Step 3: Port the components**

- Each text field binds `[formField]="form().task"` (and likewise for the others). Nested fields use the tree path: `form().leash.max_turns`.
- If Signal Forms writes `NaN` or `0` for an emptied number input, put the conversion in one place: a small `ui/` directive `nullableNumber` that maps `''` → `null` on input and is applied to all four number inputs. Don't add per-field handlers.
- The model selector keeps its `modelChoiceFor`/`modelIdForChoice` logic: a `hlm-select` or the Segmented control, matching the current markup, with the custom-id input shown when the choice is `custom`.
- `KitChecklist` keeps its local `query` signal (allowed in `ui/`). When a skill or plugin is toggled, it calls the `lib/kit.ts` helper on a `structuredClone` of `spec()` and emits `specChange`. ComposePane writes that back with `form()` root `.value.set(next)`; read the Signal Forms docs (angular-cli MCP server, Task 3) for the exact field-state write API in 22.1.
- `PromptDialog` uses `hlm-dialog` with `*hlmDialogPortal` and `hlmDialogTitle` (gate: `no-missing-composition-part`).

Run: PASS, then lint.

- [ ] **Step 4: Commit**

```bash
git add app/web-ng/src/app/ui
git commit -m "feat(workbench-ng): compose pane on signal forms, kit checklist, prompt dialog"
```

---

### Task 12: Toolbar, confirm dialog, task editor, detail actions

**Model:** Sonnet

**Files:**
- Create: `src/app/ui/toolbar.ts`, `toolbar.spec.ts`, `confirm-dialog.ts`, `confirm-dialog.spec.ts`, `task-editor.ts`, `task-editor.spec.ts`, `detail-actions.ts`, `detail-actions.spec.ts`

**Interfaces:**
- Produces:
  - `Toolbar`: inputs and outputs per `Toolbar.svelte` (New, Open, Save, Export, Run, Cancel, Library)
  - `ConfirmDialog`: `open`, `message`, `confirm`, `cancel`
  - `TaskEditor`: `task = input.required<string>()`, `run = output<string>()`, `cancel = output<void>()`
  - `DetailActions`: per `DetailActions.svelte`

- [ ] **Step 1: Port `Toolbar.test.ts` and `DetailActions.test.ts`**; write new specs for TaskEditor (Escape emits `cancel`; Ctrl+Enter with blank draft emits nothing; Ctrl+Enter with text emits `run` with the draft) and ConfirmDialog (confirm/cancel outputs; `hlmDialogTitle` present). Run: FAIL.
- [ ] **Step 2: Port the components.** Toolbar icons per the inventory list, as `lucideFilePlus`, `lucideFolderOpen`, `lucideSave`, `lucidePackage`, `lucidePlay`, `lucideSquare` and `lucideLibrary`. Check each against the imports in `Toolbar.svelte`. Exactly one `variant="primary"` button (Run) per view. Run: PASS, then lint.
- [ ] **Step 3: Commit**

```bash
git add app/web-ng/src/app/ui
git commit -m "feat(workbench-ng): toolbar, confirm dialog, task editor, detail actions"
```

---

### Task 13: Workbench screen

**Model:** Sonnet

**Files:**
- Create: `src/app/workbench/workbench.view-model.ts`, `workbench.view-model.spec.ts`, `workbench.html`, `workbench.spec.ts`
- Modify: `src/app/workbench/workbench.ts`

**Interfaces:**
- Consumes: `KataTransport`, `RunStore`, `ToastStore`, `LaunchStore`; `lib/spec.ts` (`defaultSpec`, `normalize`, `specEquals`, `draftFrom`); `lib/mock.ts` (`inTauri`, `seedSpec`); all Task 7-12 components.
- Produces: `WorkbenchViewModel`:
  - `spec: WritableSignal<RunSpec>`, `form: FieldTree<RunSpec>`, `dirty: Signal<boolean>`
  - `catalog`, `presets`, `errors` signals; the `run` store getters re-exposed
  - methods `init(demo: boolean)`, `newSpec()`, `open()`, `save()`, `export()`, `run()`, `cancel()`, `answer(e)`, `decide(e)`, `onKey(e: KeyboardEvent)`, plus confirm/prompt dialog state

- [ ] **Step 1: Write the failing ViewModel specs**

`workbench.view-model.spec.ts` uses a fake transport through DI and provides `WorkbenchViewModel` directly:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { WorkbenchViewModel } from './workbench.view-model';
import { KataTransport } from '../core/transport/kata-transport';
import { RunStore } from '../core/run/run.store';
import { ToastStore } from '../core/toast/toast.store';
import { LaunchStore } from '../core/launch/launch.store';
import { seedSpec, seedCatalog } from '../lib/mock';
import { defaultSpec } from '../lib/spec';
import type { KataEvent } from '../lib/events';

class FakeTransport {
  listeners: ((ev: KataEvent) => void)[] = [];
  onRunEvent(cb: (ev: KataEvent) => void) { this.listeners.push(cb); return Promise.resolve(() => {}); }
  runSpec = vi.fn(() => Promise.resolve());
  cancelRun = vi.fn(() => Promise.resolve());
  submitAnswer = vi.fn(() => Promise.resolve());
  submitDecision = vi.fn(() => Promise.resolve());
  catalog = vi.fn(() => Promise.resolve(seedCatalog));
  listPresets = vi.fn(() => Promise.resolve([]));
  validateSpec = vi.fn(() => Promise.resolve([] as string[]));
  loadSpec = vi.fn();
  saveSpec = vi.fn(() => Promise.resolve());
  saveKata = vi.fn(() => Promise.resolve());
  savePreset = vi.fn(() => Promise.resolve());
  exportBundle = vi.fn(() => Promise.resolve());
  pickOpenSpec = vi.fn(() => Promise.resolve(null as string | null));
  pickSaveSpec = vi.fn(() => Promise.resolve(null as string | null));
  pickDirectory = vi.fn(() => Promise.resolve(null as string | null));
}

function setup() {
  const fake = new FakeTransport();
  TestBed.configureTestingModule({ providers: [WorkbenchViewModel, { provide: KataTransport, useValue: fake }, provideRouter([])] });
  return { vm: TestBed.inject(WorkbenchViewModel), fake, store: TestBed.inject(RunStore) };
}

const TAURI = '__TAURI_INTERNALS__';

it('starts from seedSpec in the browser and from defaultSpec under Tauri, where demo is ignored', async () => {
  const a = setup();
  await a.vm.init(false);
  expect(a.vm.spec()).toEqual(seedSpec());
  TestBed.resetTestingModule();
  (window as unknown as Record<string, unknown>)[TAURI] = {};
  try {
    const b = setup();
    await b.vm.init(true);
    expect(b.vm.spec()).toEqual(defaultSpec());
    expect(b.fake.runSpec).not.toHaveBeenCalled();
  } finally {
    delete (window as unknown as Record<string, unknown>)[TAURI];
  }
});

it('runs the demo once on init when demo=true in the browser', async () => {
  const { vm, fake } = setup();
  await vm.init(true);
  expect(fake.runSpec).toHaveBeenCalledTimes(1);
});

it('does not start a second run on Ctrl+Enter while one is active (Review Focus #5)', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  vm.onKey(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
  vm.onKey(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
  await Promise.resolve();
  expect(fake.runSpec).toHaveBeenCalledTimes(1);
});

it('ignores Ctrl+Enter while a dialog is open (Review Focus #5)', async () => {
  const { vm, fake } = setup();
  await vm.init(false);
  vm.spec.update((s) => ({ ...s, task: 'changed' }));
  vm.newSpec();                     // dirty → opens the discard confirm
  vm.onKey(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
  expect(fake.runSpec).not.toHaveBeenCalled();
});

it('round-trips hidden fields and clears dirty after save (Review Focus #3)', async () => {
  const { vm, fake } = setup();
  const onDisk = { ...seedSpec(), plugins: { gh: { mcp: true, env: ['A', 'B'] } }, auth: { bare: false, token_env: 'TOK' } };
  fake.pickOpenSpec.mockResolvedValue('x.toml');
  fake.loadSpec.mockResolvedValue(onDisk);
  fake.pickSaveSpec.mockResolvedValue('x.toml');
  await vm.init(false);
  await vm.open();
  vm.spec.update((s) => ({ ...s, task: 'edited' }));
  expect(vm.dirty()).toBe(true);
  await vm.save();
  expect(fake.saveSpec).toHaveBeenCalledWith('x.toml', { ...onDisk, task: 'edited' });
  expect(vm.dirty()).toBe(false);
});

it('takes a Library launch once and auto-runs it', async () => {
  const { vm, fake } = setup();
  const spec = { ...seedSpec(), name: 'from-library' };
  TestBed.inject(LaunchStore).set({ spec, autorun: true });
  await vm.init(false);
  expect(vm.spec().name).toBe('from-library');
  expect(fake.runSpec).toHaveBeenCalledTimes(1);
  expect(TestBed.inject(LaunchStore).take()).toBeNull();
});

it('toasts a failed open', async () => {
  const { vm, fake } = setup();
  fake.pickOpenSpec.mockResolvedValue('x.toml');
  fake.loadSpec.mockRejectedValue(new Error('bad toml'));
  await vm.init(false);
  await vm.open();
  expect(TestBed.inject(ToastStore).toasts().map((t) => t.message).join(' ')).toContain('bad toml');
});

it('blocks a run and shows errors when validation fails', async () => {
  const { vm, fake } = setup();
  fake.validateSpec.mockResolvedValue(['task is required']);
  await vm.init(false);
  await vm.run();
  expect(vm.errors()).toEqual(['task is required']);
  expect(fake.runSpec).not.toHaveBeenCalled();
});
```

If `+page.svelte` normalizes the starting spec, compare against `normalize(seedSpec())`, whatever the Svelte code actually produces. Add one test per remaining orchestration branch in `routes/+page.svelte`, in the same style: export calls `exportBundle` with the picked path; save-as-preset calls `savePreset` with the prompted name; a cancelled picker (`null`) changes nothing. Run: FAIL.

- [ ] **Step 2: Implement the ViewModel**

Port the `<script>` of `routes/+page.svelte` into `WorkbenchViewModel` (`@Injectable()`, no `providedIn`). `spec` is a `signal<RunSpec>`, `form = form(this.spec)`, and `dirty = computed(() => !specEquals(normalize(this.spec()), this.saved()))`, where `saved` is a signal set on load and save. `onMount` becomes `init(demo)`. `inTauri()` decides seed vs default and whether `demo` is honored, exactly as today. Keep `save()`'s semantics exactly as `+page.svelte` has them (if Save there writes through `saveKata` rather than `saveSpec`, the test above follows the real call). Don't change behavior to fit the test.

- [ ] **Step 3: Write the component**

```ts
@Component({
  selector: 'app-workbench',
  providers: [WorkbenchViewModel],
  imports: [Toolbar, ValidationBanner, ComposePane, ObservePane, ConfirmDialog, PromptDialog],
  templateUrl: './workbench.html',
  host: { '(document:keydown)': 'vm.onKey($event)' },
})
export class Workbench {
  protected readonly vm = inject(WorkbenchViewModel);
  private readonly route = inject(ActivatedRoute);
  constructor() {
    void this.vm.init(this.route.snapshot.queryParamMap.get('demo') === 'run');
  }
}
```

`workbench.html` reproduces the `+page.svelte` markup and `wb-*` classes, wiring inputs from `vm` and outputs to `vm` methods. `workbench.spec.ts` crosses the template/ViewModel seam once (angular-jig's `missions.spec.ts` pattern): clicking the toolbar Run button calls `RunStore.startRun`.

- [ ] **Step 4: Run every gate for this screen**

Run: `npm test -- --watch=false && npm run lint && npx stylelint "src/**/*.css" && npm run build`, then
`npm run check:parity -- --only compose-seeded,compose-kit-search,compose-new-empty,compose-validation,dialog-discard,dialog-save-preset,observe-ask,observe-permission,observe-complete,observe-toolcards-open,focus-primary,hover-secondary`
Expected: all `ok`. For each `FAIL`, open `parity/diff/<view>.png`, find the drifting element, and fix it in tokens, `components.css`, `workbench.css` or the helm skin. Iterate until clean. Never touch `parity/baseline/`.

- [ ] **Step 5: Commit**

```bash
git add app/web-ng/src
git commit -m "feat(workbench-ng): workbench screen with view model, parity green"
```

---

### Task 14: Library screen

**Model:** Sonnet

**Files:**
- Create: `src/app/library/library.view-model.ts`, `library.view-model.spec.ts`, `library.html`, `library.spec.ts`
- Modify: `src/app/library/library.ts`

**Interfaces:**
- Consumes: `KataTransport`, `LaunchStore`, `Router`; EventRow, ToolCard, SummaryStat, TaskEditor, DetailActions, MarkdownBody.
- Produces: `LibraryViewModel` (state and methods ported from `routes/library/+page.svelte`, including `launch(spec, autorun)`, which calls `LaunchStore.set` then `router.navigate(['/'])`).

- [ ] **Step 1: Write the failing ViewModel specs**: loads history and katas on init; selecting a run loads its detail; a kata load failure shows in the failures list; "Run again" sets the launch payload with `autorun: true` and navigates to `/`; editing the task in TaskEditor and running launches the edited spec (`withTask`). Use a fake transport and a `Router` spy via `provideRouter([])` + `vi.spyOn(TestBed.inject(Router), 'navigate')`. Run: FAIL.
- [ ] **Step 2: Implement the ViewModel and component**, porting the Svelte page's script and markup (`wb-kata` and the other classes kept). Run: PASS.
- [ ] **Step 3: Gates.** `npm test -- --watch=false && npm run lint && npm run build && npm run check:parity -- --only library-list,library-detail` → all `ok` (fix drift as in Task 13). Then run the complete gate set: `npm run check:parity` (all 14 views), `npm run check:boot`, `npm run check:interaction`, `npm run check:responsive`, `npm run check:contrast` (if Task 4 kept it). All must pass.
- [ ] **Step 4: Manual desktop smoke (owner).** Ask the owner to run `cd app && npm run tauri:dev:ng` with an authenticated `claude` on PATH. Steps: open a real spec, run it, answer an ask, decide a permission, cancel a second run, then open the Library and Run again. Record the result in the task report. This step needs a human; don't mark it done without their confirmation.
- [ ] **Step 5: Commit**

```bash
git add app/web-ng/src
git commit -m "feat(workbench-ng): library screen, full parity and gate pass"
```

---

### Task 15: The swap

**Model:** Sonnet

**Files:**
- Delete: `app/src/routes/`, `app/src/lib/`, `app/src/app.html`, `app/src/styles/`, `app/svelte.config.js`, `app/vite.config.js`, `app/vitest.config.ts`, `app/tsconfig.json`, `app/package.json`, `app/package-lock.json`, `app/src-tauri/tauri.ng.conf.json`
- Move: `app/web-ng/*` (including dotfiles) → `app/` (`app/web-ng/src/*` → `app/src/*`, next to the untouched `app/src/bindings/`)
- Modify: `app/package.json` (merged scripts), `app/tsconfig.json` + `tsconfig.app.json` (alias → `./src/bindings/*`), `app/src-tauri/tauri.conf.json`, `.claude/settings.json`, `.github/workflows/ci.yml`, `CLAUDE.md`, `app/CLAUDE.md`, `docs/adding-a-feature.md`, `.gitignore`, `app/scripts/screenshots.mjs`, version files

**Interfaces:**
- Produces: a single frontend under `app/`, with `npm run tauri:dev` launching Angular.

- [ ] **Step 1: Delete Svelte and move Angular into place**

Use `git mv` so history follows the files. Move `app/web-ng/src/app`, `src/styles`, `src/testing`, `src/main.ts`, `src/index.html` and `src/styles.css` into `app/src/`, then everything else at the `web-ng` root into `app/`. `app/src/bindings/` stays where it is. `app/scripts/stage-sidecar.mjs` stays. Merge `app/web-ng/scripts/*` into `app/scripts/`.

- [ ] **Step 2: Merge `app/package.json` scripts**

Keep Angular's scripts and add back from the old Svelte file: `"tauri": "tauri"`, `"sidecar": "node scripts/stage-sidecar.mjs"`, `"gen:events"` (same json2ts command; its input path `../schema/kata-events.schema.json` and output `src/bindings/kata-events.ts` are unchanged), `"tauri:dev": "node scripts/stage-sidecar.mjs && tauri dev"`, `"tauri:build": "node scripts/stage-sidecar.mjs --release && tauri build"`, and `"screenshots"`. Add devDependencies `@tauri-apps/cli` and `json-schema-to-typescript` at the old versions. Set `"version": "3.2.0"`. Rewrite `scripts/screenshots.mjs` to serve with `ng serve` (copy the `serve()` helper from `check-parity.mjs`) instead of Vite, keeping its four release shots and its 2x scale. Delete the `--parity` mode and the `parity:baseline` script, since the baseline is frozen now.

- [ ] **Step 3: Repoint config**

- `tsconfig.json`: `"@bindings/*": ["./src/bindings/*"]`. `tsconfig.app.json`: drop the `../src/bindings` include, because `src/**/*.ts` now covers it.
- `tauri.conf.json`: `"beforeDevCommand": "npm start"`, `"beforeBuildCommand": "npm run build"`, `"frontendDist": "../dist/kata-workbench/browser"`, `"version": "3.2.0"`. `devUrl` stays `http://localhost:1420`.
- `.claude/settings.json`: replace `app/web-ng` with `app` in all five hook commands.
- `.gitignore`: replace the `app/web-ng/...` lines with `app/dist/`, `app/.angular/`, `app/parity/actual/`, `app/parity/diff/`, and remove `app/build/` and `app/.svelte-kit/`.
- Bump the version wherever 3.1.0 appears for the workspace (`grep -rn "3\.1\.0" --include=Cargo.toml --include=*.json .` and follow the pattern of the v3.1.0 commit `300fc80`).

- [ ] **Step 4: CI**

Delete the Svelte `web` job. Rename `web-ng` to `web`, set `working-directory: app` and `cache-dependency-path: app/package-lock.json`, and add the event-types freshness step right after `npm ci`:

```yaml
      - name: Event types freshness (regenerate & diff)
        run: |
          npm run gen:events
          git diff --exit-code src/bindings/kata-events.ts
```

The `rust` job's `node app/scripts/stage-sidecar.mjs` and its `app/src/bindings/` drift check are unchanged.

- [ ] **Step 5: Docs**

- Root `CLAUDE.md`, "The Workbench" section: the frontend is Angular 22 (angular-jig template) instead of SvelteKit. Rewrite the `api.ts`/`inTauri()`/`run.svelte.ts` paragraph to describe `KataTransport` (Tauri vs Mock, chosen in `provideKataTransport`), `RunStore` and ViewModels. Commands: replace `npm run check` with `npm run lint`, and add `npm run check:parity`, `check:boot` and `check:interaction`. Fix "Regenerate TS bindings" so it still points at `app/src/bindings/`.
- `app/CLAUDE.md`: icons are `@ng-icons/lucide` via `provideIcons` + `<ng-icon>`; controls are helm primitives skinned in `libs/ui` (never restyled at the call site); kata's non-control classes live in `src/styles/kata/`; the house rules are enforced by `npm run lint` and the root hooks; dev is `npm start` on 1420, and `?demo=run` still works.
- `docs/adding-a-feature.md`, Workbench-pane chain: replace Svelte component steps with the Angular ones (`ui/` component + spec, ViewModel wiring, `check:parity` re-bless only with owner sign-off).

- [ ] **Step 6: Verify everything**

Run (repo root): `cargo fmt --all --check && cargo test -p kata-core -p kata-cli && node app/scripts/stage-sidecar.mjs && cargo test --workspace && cargo build --locked`
Run (in `app/`): `npm ci && npm run gen:events && git diff --exit-code src/bindings/kata-events.ts && npm run lint && npx stylelint "src/**/*.css" && npm run build && npm test -- --watch=false && npm run check:boot && npm run check:parity`
Run: `cargo test -p kata-core --features ts export_bindings && git diff --exit-code app/src/bindings/`
Expected: everything green, no binding drift, all 14 parity views `ok`.
Confirm nothing Svelte is left: `grep -rn "svelte" app --include=*.ts --include=*.json --include=*.mjs -l | grep -v node_modules` returns nothing.

- [ ] **Step 7: Owner smoke on the real app**

Ask the owner to run `cd app && npm run tauri:dev` and repeat Task 14's Step 4 smoke. Don't proceed without their confirmation.

- [ ] **Step 8: Commit**

```bash
git add -A app .github .claude .gitignore CLAUDE.md docs/adding-a-feature.md
git commit -m "feat!: Workbench frontend is Angular (v3.2.0)"
```

(Use `feat:` without `!` if the owner prefers; no public contract changed.)

- [ ] **Step 9: Follow-up note**

After merge, the `house-rules-angular` concept (`C:\Users\psati\byom-memory\concepts\house-rules-angular.md` and the yokoten copy) says "Svelte in kata is a one-off and is out of scope". Tell the owner it is now stale. Don't edit it without their approval.
