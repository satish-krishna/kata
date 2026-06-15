# Kata Workbench — design rules for Claude Code

Copy this into `app/CLAUDE.md` (or merge into the repo-root `CLAUDE.md`) so every Claude Code
session on the Workbench stays on-brand. The full system lives in
`design/` (design tokens + component specs + prototypes).

## Foundation
- The app uses the **Kata design system**. Import `app/src/styles/styles.css` once (root layout);
  it carries the dark "sumi-ink" theme, IBM Plex fonts, all tokens, and the `.k-*` component
  classes. Everything below is already defined there.
- **Style only against the CSS custom properties. Never hard-code a hex value.** The accent must
  stay a single-token change.

## Non-negotiables
- **Theme:** dark only — warm sumi-ink surfaces (`--surface-app/-panel/-card/-inset`), washi-paper
  text (`--text-primary/-secondary/-muted/-faint`). Never pure black/white, never a light theme.
- **Accent:** one — **Hanada azure** `--accent` (#1e92d8). Run button, focus rings, links, active
  segments, the seal, selection. One primary action per view.
- **Status:** the andon set — `--success` jade / `--warning` amber / `--error` crimson. Never reuse
  the accent for status; always pair a status colour with a dot **and** a label.
- **Type:** `--font-sans` (IBM Plex Sans) for UI; `--font-mono` (IBM Plex Mono) for all data —
  spec keys, paths, model ids, exit codes, cost, the event stream, uppercase micro-labels.
  **13px UI base** — do not drift up.
- **Surfaces:** inputs are *inset* (darker than their card); cards are **flat at rest** (no shadow);
  shadows only for floating things (dialogs, popovers, toasts). Tight radii, hairline borders.
  No gradients, images, textures, or glass in chrome.
- **Voice:** terse, exact, imperative; sentence-case labels; literal lowercase spec keys in mono.
  No emoji.
- **Icons:** `lucide-svelte`, 1.5–2px stroke, `currentColor`.
- **Desktop only** (laptop → ultrawide). No mobile breakpoints.

## Where things live
- Tokens: `app/src/styles/tokens/{colors,typography,spacing}.css`
- Component classes: `app/src/styles/components/components.css`
- Per-component specs + the Svelte mapping table: `design/README.md`
- Pixel reference: `design/prototype/` (don't copy its code — it's
  HTML/React; recreate in Svelte).
