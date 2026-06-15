# Kickoff prompt — paste this into Claude Code

> Open Claude Code in the **kata repo root**, on the branch you're restyling (PR #2 / `workbench-ui`), with this `design_handoff_workbench_redesign/` folder unzipped inside it. Paste the block below as your first message.

---

Read `design_handoff_workbench_redesign/README.md` in full, then the prototype files it references under `design_handoff_workbench_redesign/prototype/`. These are **design references** (HTML/React) for a redesign of our Workbench GUI — do **not** ship them. Recreate the design in our existing **SvelteKit** app under `app/src/`, using our own components, stores, and the Tauri event bridge.

Plan of work — do these in order, and **show me a diff and pause for review after each step**:

1. **Foundation.** Copy `design_handoff_workbench_redesign/design_system/` into `app/src/styles/` and import `styles.css` once from the root layout (`app/src/routes/+layout.svelte`). Confirm the app is now dark with IBM Plex loaded and tokens available. No component changes yet.
2. **Toolbar** (`app/src/lib/components/Toolbar.svelte`) → the `.wb-toolbar` spec: seal, editable spec name, dirty pill, New/Open/Save/Export icon buttons, primary Run / danger Cancel.
3. **ComposePane** (`ComposePane.svelte`) → `.wb-compose` sections (Task → Identity → Kit → Model → Leash). Replace raw inputs with `.k-input/.k-textarea/.k-select/.k-seg`, each wrapped in `.k-field` showing the literal spec key.
4. **KitChecklist** (`KitChecklist.svelte`) → `.k-kit` rows (Checkbox + `.k-tag` + name + desc; plugin detail slot). Tags are jade (skill) / amber (plugin) — **not** blue/purple.
5. **ValidationBanner** (`ValidationBanner.svelte`) → `.wb-banner--error`.
6. **Observe pane** (new — replaces the `— M6` placeholder): `.wb-status` + `.wb-stream` (one `EventRow` per `KataEvent`) + `.wb-summary`. Wire it to the events the Tauri backend relays.
7. **Library route** (new — `app/src/routes/library/+page.svelte`): the rail + run detail from `prototype/library.*`.

Use the **per-file mapping table at the bottom of the README** as the source of truth. Keep all logic in the existing stores / Rust backend — the frontend stays presentational.

**Hard rules (do not drift):**
- Style **only** against the CSS custom properties from `styles.css`. **Never hard-code a hex value.** The accent (`--accent`, Hanada azure `#1e92d8`) must remain a one-line change.
- Keep the **13px** UI base — don't let it creep to 14/16.
- Inputs are the **inset** surface (darker than their card); cards have **no shadow** at rest; shadows are only for floating things.
- One azure **primary** action per view. Status uses the andon set (jade/amber/crimson) + a label, never colour alone.
- Icons: use `lucide-svelte` (names listed in the README). No emoji.
- Desktop only (laptop → ultrawide). No mobile breakpoints.

Start with **step 1** and stop for my review before step 2.

---

## Tips while you work

- If a step's diff is large, ask Claude Code to split it ("just the toolbar markup first, styles next").
- Spot-check against the prototype: run it with any static server (`npx serve design_handoff_workbench_redesign/prototype`) and compare side by side. Note the prototype's CSS links point at the design project's paths; the **real** CSS to import is `design_system/styles.css`.
- Re-state the hard rules if you ever see a hard-coded colour or the font size drifting.
