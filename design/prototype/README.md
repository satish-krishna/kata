# Prototype · The Kata Workbench (design reference)

High-fidelity, interactive recreations of the **Kata Workbench** — the Tauri v2 desktop GUI. These are the **redesign** of the unstyled prototype that shipped in `kata` PR #2 (raw browser form controls in light mode, with the Observe pane left as a `"Observe pane — M6"` placeholder). They are **design references** — recreate them in the SvelteKit app, don't ship this HTML/React. See `../README.md` for the full spec and the Svelte mapping table.

## Running these

They run as-is — no build step. Serve the folder and open any screen:

```
npx serve design/prototype      # then open index.html / library.html / hitl.html
```

Each page loads `../design_system/styles.css` (tokens + fonts + component classes) and `../design_system/_ds_bundle.js` (the compiled `window.KataDesignSystem_dd74c7` primitives), then its own scripts. Shortcuts are Windows Ctrl-based (`Ctrl+Enter` run, `Ctrl+S` save, `Ctrl+N` new).

## The three screens

**`index.html` — Workbench (Layout A).** The two-pane composer.
- **Toolbar** — seal, editable spec name, dirty indicator, New / Open / Save / Export-bundle icon buttons, primary **Run** (Ctrl+Enter) / danger **Cancel**.
- **Compose pane** — a sectioned form that *is* the `RunSpec` serialized: Description → Task / Context / Workdir → **Identity** (system prompt + append/replace) → **Kit** (searchable catalog checklist; plugins reveal `provides` + MCP toggle + env-passthrough names) → Model → **Leash** (max-turns, timeout, isolation). Each field shows its literal spec key in mono.
- **Observe pane** — a status line (andon status dot + model + isolation badge), the normalized **KataEvent** stream, and a **Summary** card on completion.
- **Status bar** — live validation (mirrors `kata-core::spec::validate`), schema, workdir, and the pinned `claude --bare -p` command.

Press **Run**: it streams events, then **pauses on an intercepted `AskUserQuestion`** (`awaiting`, amber) for a *next step* decision; answer it and the run resumes and completes (exit 0, differently per your choice). **Cancel** mid-run shows the `run.cancelled` path. Empty Task/Workdir → live validation errors. (For a focused showcase of all three question kinds, see `hitl.html`.)

**`library.html` — Library (Layout C).** A 320px rail of **saved katas** + **run history**, with a read-only **run-detail** view (summary stats, result, full event log). Click any kata or run to switch.

**`hitl.html` — Human-in-the-loop run.** Demonstrates the pause → answer → resume flow. Press **Run**: the agent isolates the bug, then the run **pauses on an intercepted `AskUserQuestion`** (`awaiting`, amber). The **AskPanel** surfaces three question kinds at once — a multiple-choice *next step*, a yes/no *open a PR?*, and an optional *text note* — and the run resumes and completes differently based on your answer.

## Files

| File | Role |
|---|---|
| `index.html` / `library.html` / `hitl.html` | Mount points — load `../design_system/styles.css` + `_ds_bundle.js`, then the screen scripts. |
| `app.jsx` | Workbench shell: spec state, validation, the simulated `kata run`. |
| `panes.jsx` | `Toolbar`, `ComposePane`, `ObservePane`, `StatusBar`. |
| `library.jsx` | The saved-katas + run-history rail and run-detail view. |
| `hitl.jsx` | The HITL run console (pause / answer / resume; uses `AskPanel`). |
| `data.js` | Default spec, discovered catalog, scripted event stream. |
| `library-data.js` | Saved katas, run history, per-run event streams. |
| `icons.js` | Lucide-style icon set (`WBIcon`). |
| `workbench.css` | Shell layout only (toolbar, panes, sections, rail, detail, HITL recap) — primitives come from the design system. |

## How it composes the system

The prototype does **not** re-implement primitives — it imports `Button`, `IconButton`, `TextInput`, `Textarea`, `Select`, `SegmentedControl`, `Checkbox`, `Field`, `Badge`, `Tag`, `StatusDot`, `Kbd`, `Card`, `KitItem`, `EventRow`, `SummaryStat`, and `AskPanel` from `window.KataDesignSystem_dd74c7`. `workbench.css` only lays out the shell. This is the intended consumption pattern.

## Fidelity notes

- The data model (`RunSpec`, the `KataEvent` types, the catalog shape) is taken verbatim from `kata-core`; the field set and validation match the Rust source.
- File pickers, real `claude` spawning, and bundle export are **out of scope** — those buttons are present and styled but inert.
- The runs are scripted simulations, not a live agent. In the real app the Tauri backend spawns the `kata` binary and relays its JSON-lines events to the webview.
