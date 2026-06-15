---
name: kata-design
description: Use this skill to generate well-branded interfaces and assets for Kata, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping. Kata is a desktop launcher for single, headless coding-agent runs — a dark "sumi-ink" dev tool with a Hanada-azure accent and the IBM Plex type system.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Where to look

- `readme.md` — the full design guide: product context, content fundamentals, visual foundations, iconography, and a file manifest. **Start here.**
- `styles.css` — link this one file to inherit all tokens, fonts, and base styles. It is dark by default.
- `tokens/` — `colors.css`, `typography.css`, `spacing.css`. Reference the semantic aliases (`--surface-card`, `--text-primary`, `--accent`, `--success`/`--warning`/`--error`), not raw ramps.
- `components/` — React primitives + `components.css` (the class layer). Compiled to `window.KataDesignSystem_dd74c7`.
- `guidelines/` — foundation specimen cards you can crib from.
- `ui_kits/workbench/` — a full interactive recreation of the product UI; the best reference for how the pieces fit together.

## House rules (do not drift)

- **Dark only.** Warm sumi-ink surfaces, washi-paper text. Never pure black/white, never a light theme.
- **One accent: Hanada azure** (`--accent #1e92d8`, 縹) for action & brand. Run **status** uses the separate andon set (jade / amber / crimson) — never reuse the accent for status, and always pair status colour with a label.
- **Type:** IBM Plex Sans for UI, IBM Plex Mono for all data (spec keys, paths, codes, event stream, micro-labels). 13px UI base.
- **Tight radii, hairline borders, flat cards.** Shadows only for floating surfaces. No gradients, images, textures, or glass in chrome.
- **Voice:** terse, exact, imperative; sentence-case labels; literal lowercase spec keys in mono. No emoji.
- **Icons:** Lucide (1.5–2px stroke). The mark is the 型 kanji on an azure seal square.
- **Desktop only** (laptop → ultrawide). No mobile layouts.
