# UI Kit · The Kata Workbench

A high-fidelity, interactive recreation of the **Kata Workbench** — the Tauri v2 desktop GUI. This is the **redesign** of the unstyled prototype that shipped in `kata` PR #2 (which rendered raw browser form controls in light mode, with the Observe pane left as a `"Observe pane — M6"` placeholder).

## What it is

`index.html` is a click-through of the real two-pane layout from the design spec:

- **Toolbar** — kata seal, editable spec name, dirty indicator, New / Open / Save / Export-bundle icon buttons, and the primary **Run** action (⌘↵).
- **Left pane — Compose the run-spec.** A sectioned form that *is* the `RunSpec` serialized: Description → Task / Context / Workdir → **Identity** (system prompt + append/replace) → **Kit** (searchable catalog checklist; plugins reveal `provides` + MCP toggle + env-passthrough names) → Model → **Leash** (max-turns, timeout, isolation). Each field shows its literal spec key in mono.
- **Right pane — Observe the run.** A status line (andon status dot + model + isolation badge), the normalized **KataEvent** stream, and a **Summary** card on completion (exit / turns / cost / duration / result).
- **Status bar** — live validation (mirrors `kata-core::spec::validate`), schema, workdir, and the pinned `claude --bare -p` command.

## Try it

Press **Run** (or ⌘↵). The Observe pane simulates a real `kata run` of the spec's `triage-flaky-test` example: it streams `log` → `turn` → `assistant.text` → `tool.use` → `tool.result` events one by one (the exact normalized protocol from `kata-core::event`), then fills the Summary card with `exit 0 · 4 turns · $0.041 · 48.1s`. Hit **Cancel** mid-run to see the `run.cancelled` path. Edit Task/Workdir to empty to see live validation errors.

## Files

| File | Role |
|---|---|
| `index.html` | Mount point — loads the DS bundle, then the kit scripts. |
| `app.jsx` | App shell: spec state, validation, the simulated `kata run`. |
| `panes.jsx` | `Toolbar`, `ComposePane`, `ObservePane`, `StatusBar`. |
| `data.js` | Default spec, discovered catalog, scripted event stream. |
| `icons.js` | Lucide-style icon set (`WBIcon`). |
| `workbench.css` | App-shell layout only — primitives come from the design system. |

## How it composes the system

The kit does **not** re-implement primitives — it imports `Button`, `IconButton`, `TextInput`, `Textarea`, `Select`, `SegmentedControl`, `Checkbox`, `Field`, `Badge`, `StatusDot`, `Kbd`, `KitItem`, `EventRow`, and `SummaryStat` from `window.KataDesignSystem_dd74c7` (the compiled bundle). `workbench.css` only lays out the shell (toolbar, panes, sections, stream). This is the intended consumption pattern for the design system.

## Fidelity notes

- The data model (`RunSpec`, the `KataEvent` types, the catalog shape) is taken verbatim from `kata-core`; the field set and validation match the Rust source.
- File pickers, real `claude` spawning, and bundle export are **out of scope** for a UI recreation — those buttons are present and styled but inert (the Browse button and toolbar actions don't open native dialogs).
- The run is a scripted simulation, not a live agent.
