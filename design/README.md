# Handoff: Kata Workbench redesign (PR #2)

## Overview

This package restyles the **Kata Workbench** — the Tauri v2 desktop GUI for composing and running a single headless coding-agent run-spec. The functional shell already exists in **`kata` PR #2** (SvelteKit, under `app/`), but it ships with **no visual language**: default browser form controls, `system-ui`, a light background, `#ccc` borders, and blue/purple tags. The Observe pane is a `"Observe pane — M6"` placeholder.

This handoff replaces that baseline with a complete **dark "sumi-ink" design system**: warm near-black surfaces, washi-paper text, a single Hanada-azure accent, an "andon" status palette, and the IBM Plex type system. It covers two screens — the two-pane **Workbench** (Layout A) and the **Library** run-history rail (Layout C).

## About the design files

The files in `prototype/` are **design references created in HTML/React** — they show the intended look and behavior. **They are not the code to ship.** The Kata app is **SvelteKit + Tauri**; the task is to **recreate these designs in the existing Svelte app** (`app/src/`), reusing its components, stores, and the Rust/Tauri command bridge. Do not introduce React.

The good news: almost everything you need is **plain CSS on custom properties**. Drop the `design_system/` CSS into the Svelte app and apply the class names; the React in the prototype is only there to make it interactive for review.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, radii, and interaction states. Recreate pixel-faithfully using the exact token values below. The prototype's measurements are the spec.

---

## Design tokens

Ship these first. Copy `design_system/` into `app/src/` (e.g. `app/src/styles/`) and import `styles.css` once from the root layout (`app/src/routes/+layout.svelte` → `<script> import '../styles/styles.css'</script>`, or link it in `app/src/app.html`). `styles.css` is an `@import` manifest that pulls in fonts, all tokens, the base reset, and the component class layer. Everything below is already defined there — this list is for reference.

### Color (the full semantic set is in `tokens/colors.css`)

| Token | Hex | Use |
|---|---|---|
| `--surface-app` | `#0c0b0a` | app base (deepest) |
| `--surface-chrome` | `#121110` | toolbar, status bar, rail |
| `--surface-panel` | `#17150f` | observe pane / inset panels |
| `--surface-card` | `#1b1916` | cards, raised rows |
| `--surface-inset` | `#211e1a` | inputs (recessed) |
| `--surface-hover` | `#26221d` | hover surface |
| `--text-primary` | `#ede7de` | primary text (washi paper) |
| `--text-secondary` | `#b3aba0` | secondary |
| `--text-muted` | `#837b70` | muted / helper |
| `--text-faint` | `#6b6359` | faint / placeholder / gutters |
| `--border-subtle` | `#2e2a24` | hairline dividers |
| `--border-default` | `#38332d` | input/control borders |
| `--border-strong` | `#4a443c` | hover borders |
| `--accent` | `#1e92d8` | **Hanada azure** — Run, focus, active tab, links, seal, selection |
| `--accent-hover` | `#3fa7e6` | accent hover |
| `--accent-press` | `#1577bc` | accent press |
| `--accent-text` | `#74c0ec` | accent text on dark |
| `--text-on-accent` | `#07121f` | text on an azure fill |
| `--success` | `#4fb477` | exit 0 (andon green) |
| `--warning` | `#e2a03f` | leash trip / worktree (andon amber) |
| `--error` | `#f04458` | non-zero exit (andon crimson) |

> **Accent: Hanada azure `#1e92d8`** (縹, "bright signal blue"), chosen from a four-way exploration (vermilion `#ee5630`, indigo `#3F7BD8`, azure `#1E92D8`, teal `#15B0B8`). The cool azure keeps brand and the error red from reading as cousins. Because every accent usage reads from `--accent` + its aliases, the accent is a **one-place edit** in `tokens/colors.css` (the `--azure-*` ramp and the `--accent*` aliases) if it ever changes again. Build against the tokens, never hard-coded hex.

### Type (`tokens/typography.css`)

- **`--font-sans`**: `'IBM Plex Sans'` — all UI text.
- **`--font-mono`**: `'IBM Plex Mono'` — all *data*: spec keys, paths, model ids, exit codes, cost, the event stream, and uppercase micro-labels.
- Fonts load from Google Fonts CDN in `fonts.css` (weights 400/500/600/700). **To self-host** (recommended for a desktop app — no network at launch), vendor the `.woff2` files into the app and replace the `@import` with local `@font-face` rules.
- Scale (px): `2xs 10 · xs 11 · sm 12 · base 13 · md 14 · lg 16 · xl 20 · 2xl 26 · 3xl 34`. **UI base is 13px.** Dense, IDE-like — keep it.
- Micro-label (the recurring eyebrow): Plex Mono, 10px, `letter-spacing: 0.12em`, uppercase, `--text-muted`. Class `.kata-eyebrow`.

### Spacing, radii, elevation, motion (`tokens/spacing.css`)

- **Spacing**: 4px grid — `--space-2 4 · 3 8 · 4 12 · 5 16 · 6 20 · 7 24 · 8 32 · 10 48`.
- **Radii**: `--radius-xs 3` (tags) · `sm 5` (inputs/buttons) · `md 7` (cards/rows) · `lg 10` (panels) · `xl 14` · `full 999`.
- **Borders**: 1px hairlines do the structural work. Cards are **flat at rest — no drop shadow.** Shadows (`--shadow-md/-lg/-popover`) are only for floating things (dialogs, popovers, toasts).
- **Motion**: `--dur-fast 110ms · --dur-base 170ms`, `--ease-out cubic-bezier(.22,.61,.36,1)`. Hover/press near-instant. The one expressive motion is the **running** status dot pulse (`@keyframes k-pulse`); respect `prefers-reduced-motion`.
- **Layout rails**: `--rail-toolbar 48px`, `--rail-statusbar 32px`, `--pane-min 380px`.

---

## Screens / Views

### 1 — Workbench (Layout A) · `prototype/index.html`

**Purpose:** Compose a run-spec on the left; run it and observe to completion on the right.

**Layout:** A flex **column** filling `100vh`: fixed `48px` toolbar → optional validation banner → flexible two-pane row → fixed `32px` status bar. The pane row is `display:flex`; the **compose** pane is `flex:1.05` with a `1px` right border, the **observe** pane is `flex:1` on `--surface-panel`. Each pane has a `38px` header (a `.kata-eyebrow`) and an independently scrolling body. `min-width:380px` per pane. On ultrawide (`min-width:1920px`) the compose form caps at `820px`; the observe pane keeps the slack.

**Components & exact styling** (all class names live in `design_system/components/components.css`):

- **Toolbar** (`.wb-toolbar`, height 48, `--surface-chrome`, bottom `1px --border-default`): left to right — the **seal** (`.wb-seal`: 26px azure `--radius-xs` square, kanji `型` in `#fbeee6`, mincho serif 16px), a vertical `1px` separator, an **editable spec-name** input (transparent until hover/focus, Plex Sans 600 14px, 240px wide), a **dirty pill** (`● unsaved` in `--warning-text` when dirty / `saved` in `--text-faint`), a flex spacer, an icon-button group (New / Open / Save / Export bundle), a separator, then the primary **Run** button (`.k-btn--primary` + a `⌘↵` `.k-kbd`). When running, Run is replaced by a `.k-btn--danger` **Cancel** with a stop-square icon.
- **Validation banner** (`.wb-banner--error`, only when invalid): `--error-subtle` bg, `--error-text`, an `alert-triangle` icon, then the error strings inline (mono 12px). Mirrors `kata-core::spec::validate`.
- **Compose form** (`.wb-compose`, padding `20px 20px 64px`, `gap:24px`): a stack of **sections** (`.wb-section`). Each section header (`.wb-section__head`) has an optional azure mono number/eyebrow (`02 · TELL IT WHAT IT IS`), a Plex-Sans-600 16px title, and an optional right-aligned faint sub. The four spec decisions are sections: **Task** (task / context textareas + Workdir picker), **Identity** (system-prompt textarea + append/replace segmented control), **Kit** (search box + catalog checklist), **Model** (select), **Leash** (max-turns + timeout in a 2-col grid, isolation segmented control).
  - **Field** (`.k-field`): label row (`.k-field__label`, Plex Sans 500 12px `--text-secondary`) with the **literal spec key** in mono `--text-faint` beside it (e.g. `max_turns`); the control; a hint line (`.k-field__hint`, 11px `--text-faint`) that turns `--error-text` on error.
  - **Inputs** (`.k-input` / `.k-textarea`): `--surface-inset` (recessed), `1px --border-default`, `--radius-sm`, height 32. Focus → `--accent` border + `0 0 0 3px --accent-subtle` ring. Add `.k-input--mono` for paths/codes.
  - **Segmented control** (`.k-seg`): inset track, 2px padding; active option fills `--accent` with `--text-on-accent`, mono 12px. Used for `append`/`replace` and `none`/`worktree`.
  - **Kit checklist** (`.k-kit` rows): each row a `Checkbox` + a **Tag** (`.k-tag--skill` jade / `.k-tag--plugin` amber) + mono name + right-aligned truncated description. Selected rows get an `--accent-border` and a faint accent wash; a selected **plugin** expands a `.k-kit__detail` slot (dashed top border) showing its `provides:` line, an MCP-servers checkbox, and an env-passthrough mono input (names only).
- **Observe pane** (`.wb-pane--observe`): a `44px` **status line** (`.wb-status`, `--surface-card`) with a `StatusDot` (idle/running/success/warning/error — running **pulses** azure), a separator, the model in mono, and a `worktree` warning badge when isolated. Below, the **event stream** (`.wb-stream`, scrolls, fills height); empty state shows a `terminal` icon + prompt. Each event is an `EventRow`:
  - `.k-event__gutter` — fixed 64px left rail, uppercase 10px mono label (`assistant` / `tool` / `result` / `turn 3` / `log`).
  - `.k-event__body` — `assistant.text` renders in **Plex Sans** `--text-primary`; everything else in mono `--text-secondary`. `tool.use` rows get a `--surface-panel` band + accent gutter + bold tool name; `tool.result` gutter is jade (ok) or crimson (error); `turn` is a faint divider.
  - New rows animate in (`.wb-event-enter`, 3px rise + fade, `--dur-base`); reduced-motion disables it.
  - On `run.completed`, a **Summary** block (`.wb-summary`) pins to the bottom: a `run.completed` badge (success/error), then a 4-up grid of **SummaryStat** (`.k-stat`: uppercase mono label + big 26px mono value; EXIT tinted by outcome) for EXIT / TURNS / COST / DURATION, then the result text in an inset card.
- **Status bar** (`.wb-statusbar`, height 32, `--surface-chrome`): left = live validity (`check-circle` + "spec is valid" in jade, or `alert-triangle` + first error in crimson); right = `schema 1`, the workdir, and the pinned `claude --bare -p` command — all mono 11px `--text-faint`.

### 2 — Library (Layout C) · `prototype/library.html`

**Purpose:** Browse saved katas (named run-specs) and run history; review a past run read-only.

**Layout:** Same toolbar/status-bar column. The pane row is a **fixed 320px rail** (`.wb-pane--rail`, `--surface-chrome`, right border) + a flexible **run-detail** view (`.wb-detail`, `--surface-panel`).

- **Rail:** a `Library` eyebrow header, a full-width primary **New kata** button (`⌘N`), then two scrolling sections. **Saved katas** (`.wb-kata` rows): mono name + a status dot (last-run outcome), a truncated description, and a meta line (`worktree` / kit count / run count with icons). Active row gets an accent wash + border. **Recent runs** (`.wb-hist` rows): a state dot, kata name + `when · turns · cost` line, and an `exit N` badge toned by outcome.
- **Run detail:** header with the kata name (Plex Sans 600 20px) + run id + a `StatusDot` showing `exit N`; a sub-line of `clock` / `hash` / `coins` / `cpu` meta; an action row (**Re-run** primary, **Open in compose** secondary, **Export bundle** ghost). Body: a 4-up SummaryStat grid, the result text in a card, then the **event log** rendered with the same `EventRow` component as the live pane. Empty state prompts to pick a row.

---

## Interactions & behavior

- **Run** (button or **⌘↵ / Ctrl+↵**): clears the pane, sets state `running` (dot pulses, Cancel shows), then streams the normalized `KataEvent`s. In the real app this is the Tauri bridge: the backend **spawns the `kata` binary**, relays its JSON-lines events to the webview; the frontend stays presentational (per the spec's testing strategy). The prototype fakes this with a scripted timeline (`prototype/data.js`).
- **Cancel**: kills the run; the engine traps it, cleans up the plugin-dir + worktree, emits `run.cancelled`; UI goes to `warning`.
- **On `run.completed`**: render the Summary block; state → `success` (exit 0) or `error` (non-zero).
- **Live validation** (`prototype/app.jsx` `validate()`, mirrors the Rust): `name`, `task`, `workdir` required; `schema === 1`; `leash.max_turns >= 1`. Errors show in the banner + status bar; **Run is blocked** while invalid. Messages are lowercase and terse ("task is required").
- **Dirty tracking**: compare current spec JSON to the last-saved snapshot; show `● unsaved`.
- **Library navigation**: selecting a run loads its detail + event log; selecting a saved kata jumps to its latest run.
- **Hover** lightens a surface one step; **press** darkens the accent + `translateY(0.5px)`; **focus** is the 2px azure ring (`--focus-ring`). **Disabled** = opacity 0.45.

## State management (Svelte stores)

- `spec` — the `RunSpec` object (writable store); two-way bound to the compose fields. Shape is `app/src/bindings/` (already generated from `kata-core` via ts-rs).
- `savedSpecJson` — last-saved snapshot for the dirty flag.
- `runState` — `'idle' | 'running' | 'success' | 'warning' | 'error'`.
- `events` — array of received `KataEvent`s (appended as the Tauri backend relays them).
- `summary` — the `run.completed` payload, or null.
- `catalog` — from `kata catalog` (Tauri command); populates the Kit checklist.
- Library: `savedKatas`, `history`, selected run/kata ids.

## Assets & iconography

- **Icons:** Lucide (1.5–2px stroke, `currentColor`) at 16/18px. The prototype hand-rolls the needed subset in `prototype/icons.js`; in the Svelte app use [`lucide-svelte`](https://lucide.dev) — names used: `file-plus, folder-open, folder, save, package, play, square, search, git-branch, terminal, clock, coins, hash, cpu, alert-triangle, check-circle, x-circle`. (Lucide is a flagged substitution — the repo had no icon set.)
- **Mark:** the kanji **型** on an azure `--radius-xs` square (the seal). Built from type, no asset file. Swap for real artwork if the team has it.
- **No emoji.** Functional Unicode only (`●` status dots are CSS).

## Files in this bundle

- `design_system/` — **drop-in CSS.** `styles.css` (import this one), `fonts.css`, `base.css`, `tokens/{colors,typography,spacing}.css`, `components/components.css`. All class names referenced above are here.
- `prototype/` — the reference designs:
  - `index.html` + `app.jsx` + `panes.jsx` — the Workbench (Layout A).
  - `library.html` + `library.jsx` — the Library (Layout C).
  - `data.js`, `library-data.js` — fixtures (default spec, catalog, scripted streams, saved katas, history).
  - `icons.js` — the Lucide subset.
  - `workbench.css` — **shell layout** (toolbar, panes, sections, rail, detail). Pair this with `components/components.css`. You can lift it almost verbatim into the Svelte app's global stylesheet.
  - `README.md` — prototype-specific notes.

## Mapping onto the existing PR #2 Svelte files

| PR #2 file | What to do |
|---|---|
| `app/src/app.html` (or `+layout.svelte`) | Import `styles.css` once. Set `<body>` to inherit the dark base (it already does via `base.css`). |
| `app/src/routes/+page.svelte` | Becomes the Workbench column: toolbar + banner + `.wb-panes` + status bar. Lift the structure from `prototype/index.html` + `panes.jsx`. |
| `Toolbar.svelte` | Restyle to `.wb-toolbar` (seal, spec name, dirty pill, icon group, Run/Cancel). |
| `ComposePane.svelte` | Restyle to `.wb-compose` sections; replace raw `<input>/<select>/<textarea>` with `.k-input/.k-select/.k-textarea/.k-seg`, each wrapped in `.k-field` with the spec key shown. |
| `KitChecklist.svelte` | Restyle rows to `.k-kit` (Checkbox + `.k-tag` + name + desc; plugin detail slot). Replace the blue/purple tags with `--tag-skill-*` (jade) / `--tag-plugin-*` (amber). |
| `ValidationBanner.svelte` | Restyle to `.wb-banner--error`. |
| **Observe pane (new — was the `— M6` placeholder)** | Build `.wb-status` + `.wb-stream` (EventRow per `KataEvent`) + `.wb-summary`. See `panes.jsx` `ObservePane`. |
| **New: Library route** (`app/src/routes/library/+page.svelte`) | Build the rail + run detail from `prototype/library.jsx`. |

**Watch-outs:** keep the 13px base (don't let it drift up to 14/16); inputs are the *inset* surface (darker than their card), not raised; cards have **no shadow** at rest; tags are warm (jade/amber), never blue/purple; one azure primary action per view. Build everything against the CSS variables so the pending accent decision is a single-file change.
