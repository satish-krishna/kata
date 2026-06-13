# M5 Workbench — Execution Resumption Point

**Last updated:** 2026-06-13 (paused after Task 4)
**Branch:** `feat/m5-workbench-compose` (tracks `origin/feat/m5-workbench-compose`, pushed through the doc commits; M5 task commits are local-only and unpushed)
**Plan:** `docs/superpowers/plans/2026-06-13-m5-workbench-compose.md`
**Spec:** `docs/superpowers/specs/2026-06-13-m5-workbench-compose-design.md`
**Execution mode:** subagent-driven-development (superpowers). Implement → spec review → code-quality review per task; final review at the end.

## Model assignment (per user)
- **Implementer:** Haiku — but ESCALATE to Sonnet when a task needs more reasoning / repeatedly fails (sanctioned by the skill). Task 3 fixes and all reviews so far used Sonnet.
- **Reviews (spec + code-quality):** Sonnet.
- **Final review:** Opus.

## Environment constraints (CRITICAL — tell every subagent)
- Repo: `D:\Repos\kata`. Stay on branch `feat/m5-workbench-compose`.
- The agent/Bash shell **cannot delete or rename files** on this mount → run ALL `git` commands and ALL file deletes/moves in **PowerShell** (`git -C "D:\Repos\kata" ...`, `Remove-Item -Recurse -Force`, `robocopy`).
- `cargo` and `npm` work from Bash. Use `npm --prefix app <args>` (no cd).
- Conventional-commits for messages.

## Progress
| Task | Status | Final commit |
|------|--------|--------------|
| 1. kata-core `roots_for_workdir` | ✅ done (both reviews ✅) | `380196e` |
| 2. kata-core `to_toml` + `save` | ✅ done (both reviews ✅) | `fca3026` |
| 3. kata-core ts-rs bindings | ✅ done (both reviews ✅) | `4ad2ae7` |
| 4. Scaffold Tauri app | ✅ done (spec review ✅) | `4053fe0` |
| 5. Backend commands | ⏳ NEXT | — |
| 6. Frontend helpers + Vitest | pending (needs SvelteKit adaptation) | — |
| 7. Frontend compose UI | pending (needs SvelteKit adaptation) | — |
| 8. E2E smoke + ROADMAP | pending | — |

`HEAD` = `4053fe0`. Working tree is clean.

## Deviations from the written plan discovered during execution (IMPORTANT)

1. **ts-rs `export_to` depth:** the plan says `"../../app/src/bindings/"` (two `../`). The CORRECT value is **`"../../../app/src/bindings/"`** (three `../`) — ts-rs resolves relative to `current_dir()/bindings/`, and `cargo test` runs with cwd = `crates/kata-core`. Already fixed in code. The bindings-sync check (`cargo test -p kata-core --features ts export_bindings` leaves `git status` clean) passes.

2. **ts-rs serde-compat disabled:** to avoid `failed to parse serde attribute` warnings, `ts-rs` is declared with `default-features = false`, and the three enums (`IdentityMode`, `Isolation`, `EntryKind`) carry an explicit `#[cfg_attr(feature = "ts", ts(rename_all = "lowercase"))]` so their TS unions stay lowercase. Done in Task 3.

3. **SvelteKit (SPA), not plain Svelte+Vite (user decision):** the Tauri `svelte-ts` scaffolder produces **SvelteKit + adapter-static in SPA mode** (`export const ssr = false`, `fallback: index.html`). The user approved keeping it (it's Tauri's recommended Svelte setup; pure SPA = no SSR, satisfying the design's intent). **Tasks 6 & 7 must be adapted from the plan's plain-Svelte layout — see below.**

4. **Tauri crate facts:** `[package] name = "kata-app"`, `[lib] name = "app_scaffold_lib"`. `app/src-tauri/src/main.rs` calls `app_scaffold_lib::run()`. The scaffold also pulled in `tauri-plugin-opener` and a placeholder `greet` command in `lib.rs`. Frontend build output is `app/build` (not `dist/`).

## SvelteKit adaptation notes for Tasks 6 & 7
- **Helpers (Task 6):** still `app/src/lib/api.ts`, `app/src/lib/spec.ts`, `app/src/lib/kit.ts` (+ `*.test.ts`). The plan's code is valid as-is; bindings import via relative `../bindings/RunSpec` etc. (bindings live at `app/src/bindings/`, helpers at `app/src/lib/` → `../bindings`). Use `@tauri-apps/api/core` for `invoke`.
  - **Vitest caveat:** the `sveltekit()` plugin in `vite.config.js` can interfere with Vitest. If `npm --prefix app run test` fails to run because of the SvelteKit plugin, add a dedicated `app/vitest.config.ts` (plain, `test: { environment: 'node' }`, no sveltekit plugin) so the pure-TS helper tests run. Verify tests actually execute.
- **Compose UI (Task 7):** instead of `App.svelte` + `main.ts` + `index.html`, put the compose pane in **`app/src/routes/+page.svelte`** (replace the scaffold's greet demo). Components go in `app/src/lib/components/` and import via the `$lib` alias (`$lib/components/Toolbar.svelte`) or relative paths. `ssr = false` is already set in `+layout.ts`, so `invoke`/browser APIs are client-only and safe. The plan's component code and the `$state`/`$effect`/`$state.snapshot` logic port directly into `+page.svelte`.
- **Backend (Task 5):** replace `app/src-tauri/src/lib.rs` but KEEP the lib named `app_scaffold_lib` and keep `pub fn run()` (main.rs depends on it). Register `tauri_plugin_dialog::init()` and the four commands (`catalog`, `load_spec`, `save_spec`, `validate_spec`) per the plan. You may drop the `greet`/opener placeholder. Overwrite `app/src-tauri/capabilities/default.json` to grant `core:default`, `dialog:allow-open`, `dialog:allow-save` (remove opener perms if present, since we drop opener). Verify `cargo build -p kata-app` and `cargo clippy -p kata-app --all-targets` are clean.

## To resume
1. Re-read this file and the plan (`docs/superpowers/plans/2026-06-13-m5-workbench-compose.md`).
2. Continue with **Task 5 (Backend commands)** — dispatch a Haiku implementer with the plan's Task 5 text PLUS the SvelteKit/lib-name notes above. Base SHA `4053fe0`.
3. Then Task 6 (helpers + Vitest, with the Vitest caveat), Task 7 (compose UI in `+page.svelte`), Task 8 (E2E smoke + ROADMAP).
4. After Task 8: dispatch the **final review with Opus**, then use `superpowers:finishing-a-development-branch` to decide merge/PR. (Branch is unpushed for M5 commits; push before opening a PR.)

## Quick verification commands (sanity check on resume)
```
git -C "D:\Repos\kata" log --oneline -8        # PowerShell
cargo build --locked                            # Bash — whole workspace
cargo test -p kata-core --features ts export_bindings   # then `git status` must be clean
npm --prefix app run build                      # SvelteKit SPA build -> app/build
```
