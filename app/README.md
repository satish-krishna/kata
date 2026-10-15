# Kata Workbench

The Workbench is a Tauri v2 desktop app with an Angular 22 frontend (this directory) over a Rust backend (`src-tauri/`). See `CLAUDE.md` here for the design rules and gate commands, and the root `CLAUDE.md` for how the app relates to the `kata` engine.

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) + [Angular Language Service](https://marketplace.visualstudio.com/items?itemName=Angular.ng-template) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

## Commands

- `npm start` serves the app in a browser on `http://localhost:1420` with the mock transport.
- `npm run tauri:dev` stages the `kata` sidecar and launches the desktop app against the live engine.
