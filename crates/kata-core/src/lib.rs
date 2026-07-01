//! Kata engine — the reference implementation of the two cross-language
//! contracts: the run-spec ([`RunSpec`]) and the event protocol ([`KataEvent`]).
//!
//! # In-process (Rust)
//!
//! Link the library and drive a run directly, receiving every [`KataEvent`] as a
//! callback:
//!
//! ```no_run
//! let spec = kata_core::spec::load("run.toml".as_ref())?;
//! let catalog = kata_core::catalog::discover(
//!     &kata_core::catalog::roots_for_workdir(Some(&spec.workdir)));
//! let cancel = kata_core::CancelToken::new();
//! let (_answer_tx, answers) = kata_core::answer_channel();
//! let outcome = kata_core::run(&spec, &catalog, &cancel, &answers, |ev| {
//!     println!("{}", serde_json::to_string(&ev).unwrap());
//! })?;
//! # let _ = outcome;
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Out-of-process (any language)
//!
//! Spawn the `kata` binary and read one [`KataEvent`] JSON object per line off
//! its stdout; write `cancel` / `answer <id> <json>` lines to its stdin. Only
//! the run-spec and event shapes are contractual — not this crate's Rust API.
//!
//! # Interactive runs need an MCP `ask` server
//!
//! When `[interactive] enabled = true`, [`run`] launches claude with an MCP
//! server backing the `ask_user` tool: it re-invokes the current executable with
//! a `mcp-ask` argument, expecting that process to call [`serve_stdio`] and exit
//! — true for the `kata` binary and the GUI sidecar. A library consumer that
//! links [`run`] into its own binary must therefore add a `mcp-ask` guard to the
//! top of its `main` that calls [`serve_stdio`] before anything else, or
//! interactive runs cannot reach the operator.

// ---- the run-spec contract ----
pub mod spec;
pub use spec::{validate, RunSpec};

// ---- the event protocol contract ----
pub mod event;
pub use event::{KataEvent, Question, QuestionKind, QuestionOption};

// ---- discovery & orchestration ----
pub mod catalog;
pub mod run;
pub use run::{answer_channel, run, Answer, AnswerRx, CancelToken, RunError, RunOutcome};

// ---- the interactive ask MCP server (only serve_stdio is public API) ----
pub mod ask;
pub use ask::serve_stdio;

// ---- portable operations the GUI and CLI also build on ----
pub mod bundle;
pub mod history;
pub mod katas;
pub mod presets;
pub mod worktree;

// ---- engine-internal plumbing: NOT public API ----
pub(crate) mod assemble;
pub(crate) mod command;
pub(crate) mod fsutil;
