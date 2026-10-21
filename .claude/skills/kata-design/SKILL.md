---
name: kata-design
description: Use this skill to generate well-branded interfaces and assets for Kata, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping. Kata is a desktop launcher for single, headless coding-agent runs — a dark "sumi-ink" dev tool with a Hanada-azure accent and the IBM Plex type system.
user-invocable: true
---

Read `design/README.md` (repo root), and explore the other files under `design/`.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Where to look

All paths are relative to the repository root.

- `design/README.md` — the full design guide: product context, content fundamentals, visual foundations, iconography, and a file manifest. **Start here.** `design/CLAUDE.md` carries the rules for working in that folder.
- `design/design_system/styles.css` — link this one file to inherit all tokens, fonts, and base styles. It is dark by default. `fonts.css` and `base.css` sit beside it.
- `design/design_system/tokens/` — `colors.css`, `typography.css`, `spacing.css`. Reference the semantic aliases (`--surface-card`, `--text-primary`, `--accent`, `--success`/`--warning`/`--error`), not raw ramps.
- `design/design_system/components/components.css` — the class layer (`.k-*`). The React primitives behind it are compiled into `design/design_system/_ds_bundle.js` (`window.KataDesignSystem_dd74c7`), needed only to run the prototypes.
- `design/prototype/` — the interactive HTML/React recreation of the product UI (`index.html`, `hitl.html`, `library.html`, `workbench.css`); the best reference for how the pieces fit together. Recreate in Angular, never copy.
- `design/screenshots/` — rendered reference shots.

## House rules (do not drift)

- **Dark only.** Warm sumi-ink surfaces, washi-paper text. Never pure black/white, never a light theme.
- **One accent: Hanada azure** (`--accent #1e92d8`, 縹) for action & brand. Run **status** uses the separate andon set (jade / amber / crimson) — never reuse the accent for status, and always pair status colour with a label.
- **Type:** IBM Plex Sans for UI, IBM Plex Mono for all data (spec keys, paths, codes, event stream, micro-labels). 13px UI base.
- **Tight radii, hairline borders, flat cards.** Shadows only for floating surfaces. No gradients, images, textures, or glass in chrome.
- **Voice:** terse, exact, imperative; sentence-case labels; literal lowercase spec keys in mono. No emoji.
- **Icons:** Lucide (1.5–2px stroke). The mark is the 型 kanji on an azure seal square.
- **Desktop only** (laptop → ultrawide). No mobile layouts.
