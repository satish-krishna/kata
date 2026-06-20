# Render Claude's markdown in the Observe pane

> Recovered from the interactive `kata-markdown-support` brainstorming run (2026-06-20T16:12:59Z). The run delivered this design as its final message but did not persist it to a file; this is that deliverable, captured verbatim.

## Problem statement

Claude's assistant output is markdown — `**bold**`, `## headers`, fenced code, lists, tables — but the Workbench Observe pane renders it as literal plain text. `EventRow.svelte:16` drops `bodyFor(ev)` into a bare `<span>`, and for `assistant.text` that body is the raw `ev.text` string (`events.ts:119`). So readers see `**stars**` and `# hashes` instead of formatted prose. Goal: render `assistant.text` rows and the `run.completed` result block as **full block markdown** (headers, lists, tables, fenced code, blockquotes, links), themed to the Kata design system, without touching the CLI's JSON-lines contract.

## Scope (confirmed)

- **Surface:** Workbench Observe pane only. The `kata` CLI keeps emitting raw JSON-lines (`main.rs:209`) — it's a machine contract Shokunin and CI depend on; rendering there is explicitly out of scope.
- **Bodies:** `assistant.text` rows + the `run.completed` result summary block (`ObservePane.svelte:95`). Tool summaries and log messages stay literal — they're terse machine strings, not prose.
- **Richness:** full GitHub-flavored block markdown, including tables and fenced code.

## Constraints

- **Design law is binding** (`app/CLAUDE.md`): style only against CSS custom properties, never hard-code hex; dark sumi-ink only; single Hanada-azure accent; mono for data/code, sans for UI prose; no gradients/shadows in chrome. Every rendered markdown element must map onto existing `--*` tokens.
- **Tauri webview is the runtime.** Injected script is more dangerous here than in a browser tab, so a raw-HTML (`{@html}`) path is a real, not theoretical, risk.
- **CSP blocks external fetches** (it already blocks the font CDN). Any dependency must be fully bundled — no runtime CDN, no remote anything.
- **Svelte 5** (runes) frontend; presentational-only (`api.ts`/`mock.ts` fixture parity must survive).
- **Presentation-layer change only** — no `KataEvent` protocol or `RunSpec` change, so no ts-rs regeneration, no contract churn.

## Assumptions

- Each `assistant.text` event carries a **complete** text block (`event.rs:149`), so no incremental/partial-markdown parsing is needed — every body is a complete, parseable string.
- Assistant output is "semi-trusted": it's Claude's own text driven by the user, but markdown can embed raw HTML and arbitrary links, so defense-in-depth still applies.
- The fix is purely visual; history replay (`RunDetail.events`) renders through the same `EventRow`, so it benefits for free.

## Unknowns / things to settle at implementation time

- **Prose font in a mono stream.** The event stream is specified as mono. Rendered markdown prose may read better in sans while keeping code/inline-code in mono — a per-element styling call, not a blocker, but it needs a deliberate decision.
- **Link behavior in a desktop app.** Clicking a link inside Tauri should open the system browser (`shell.open`), not navigate the webview. Needs handling in the component-override map.
- **Vertical density.** Headers and tables are tall; the stream is meant to be scannable. May want capped header sizes / compact table styling to stay on-brand.
- **Bundle weight & maintenance** of the chosen library's remark/rehype tree — worth a quick size check before committing.

## Approaches considered

**A — `marked` + DOMPurify via `{@html}`.** Markdown → HTML string → sanitize → inject. Fastest to ship, fullest feature set out of the box. *Against:* a live XSS surface that leans entirely on DOMPurify staying correct, inside a Tauri webview where that matters most; and styling the generated HTML forces `:global()` selectors that fight Svelte's scoped CSS and the token discipline.

**B — Svelte-native component renderer (recommended).** A Svelte-5 markdown component (e.g. `svelte-exmarkdown`) with a GFM plugin for tables, plus a component-override map so each node — code, list, table, link — becomes a small element styled directly against design tokens. *For:* no `{@html}`, safe by construction, CSP-clean, and the override map is exactly the hook needed to obey the design system per element. *Against:* one well-scoped dependency plus its remark/rehype tree; a small API to learn.

**C — `marked` tokens → custom recursive Svelte renderer.** Parse to tokens, render with your own recursive component. Maximum control, minimal deps, no `{@html}`. *Against:* you write and test a renderer for every node type — tables, nested lists, code fences — which is real surface area and ongoing maintenance for something the ecosystem already solves.

## Recommended direction: B

Render `assistant.text` and the result summary through a **Svelte-native markdown component** (`svelte-exmarkdown` or equivalent) with a **remark-gfm** plugin for tables and a **component-override map** that styles every node against Kata's design tokens; route links through the Tauri shell-open.

Rationale: it's the only option that is *simultaneously* safe-by-construction (no raw-HTML injection in a Tauri webview), fully featured (block markdown incl. tables), and natively styleable per element — which is non-negotiable given the binding design system. It avoids both the XSS/`:global()` friction of A and the reinvent-a-parser maintenance burden of C, at the cost of a single well-scoped, fully-bundled dependency. The change stays purely presentational: no protocol or `RunSpec` change, history replay benefits for free, and the CLI contract is untouched.
