# Kata Workbench — design rules for Claude Code

Keep every session on the Workbench on-brand. The full system lives in `design/` (design tokens + component specs + prototypes), vendored into this app under `app/src/styles/`.

## Foundation
- The app uses the **Kata design system**. `app/src/styles/styles.css` is imported once (root layout `src/routes/+layout.svelte`); it carries the dark "sumi-ink" theme, IBM Plex fonts, all tokens, and the `.k-*` component classes. The app-shell layout lives in `app/src/styles/workbench.css`. Everything below is already defined there.
- **Style only against the CSS custom properties. Never hard-code a hex value.** The accent must stay a single-token change.

## Non-negotiables
- **Theme:** dark only — warm sumi-ink surfaces (`--surface-app/-panel/-card/-inset`), washi-paper text (`--text-primary/-secondary/-muted/-faint`). Never pure black/white, never a light theme.
- **Accent:** one — **Hanada azure** `--accent` (#1e92d8). Run button, focus rings, links, active segments, the seal, selection. One primary action per view.
- **Status:** the andon set — `--success` jade / `--warning` amber / `--error` crimson. Never reuse the accent for status; always pair a status colour with a dot **and** a label.
- **Type:** `--font-sans` (IBM Plex Sans) for UI; `--font-mono` (IBM Plex Mono) for all data — spec keys, paths, model ids, exit codes, cost, the event stream, uppercase micro-labels. **13px UI base** — do not drift up.
- **Surfaces:** inputs are *inset* (darker than their card); cards are **flat at rest** (no shadow); shadows only for floating things (dialogs, popovers, toasts). Tight radii, hairline borders. No gradients, images, textures, or glass in chrome.
- **Voice:** terse, exact, imperative; sentence-case labels; literal lowercase spec keys in mono. No emoji.
- **Icons:** `@lucide/svelte`, 1.5–2px stroke, `currentColor` (per-icon imports, e.g. `@lucide/svelte/icons/play`).
- **Desktop only** (laptop → ultrawide). No mobile breakpoints.

## Where things live
- Tokens: `app/src/styles/tokens/{colors,typography,spacing}.css`
- Component classes: `app/src/styles/components/components.css`; shell layout: `app/src/styles/workbench.css`
- Self-hosted fonts: `app/src/styles/fonts/` + `app/src/styles/fonts.css` (CSP blocks the CDN — re-copy woff2 from `@fontsource/ibm-plex-{sans,mono}` to refresh)
- Reusable Svelte primitives: `app/src/lib/components/` (`Field`, `Segmented`, `EventRow`, `SummaryStat`, `Toolbar`, `ComposePane`, `KitChecklist`, `ValidationBanner`, `ObservePane`)
- Per-component specs + the Svelte mapping table: `design/README.md`
- Pixel reference: `design/prototype/` (don't copy its code — it's HTML/React; recreate in Svelte)

## Dev / review (browser without the native app)
- `npm run dev` → `http://localhost:1420`. Tauri `invoke`/`listen` are unreachable in a plain browser, so `src/lib/api.ts` gates on `inTauri()` and falls back to fixtures in `src/lib/mock.ts`.
- `npm run check` type-checks Svelte (svelte-kit sync + svelte-check); `npm test` runs the Vitest suite (`*.test.ts`).
- `http://localhost:1420/?demo=run` auto-starts the scripted Observe-pane run (browser-only, never under Tauri) — useful for screenshots.
- The run bridge (`run_spec`/`cancel_run` in `src-tauri/src/lib.rs`) relays `KataEvent`s over the `kata://event` channel; the frontend stays presentational (store: `src/lib/run.svelte.ts`).
- The real engine path runs under Tauri only: `npm run tauri:dev` stages the `kata` sidecar (builds `kata-cli`, copies it to `src-tauri/binaries/kata-<target-triple>`) then launches the desktop app, which spawns `kata run` and relays its live JSON-lines. `npm run dev` (browser) keeps the scripted `mock.ts` timeline for screenshots. A real run needs an authenticated `claude` on PATH.
