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
//! # Interactive runs are owned by the `kata` process
//!
//! When `[interactive] enabled = true`, the engine hosts the `ask_user` MCP tool
//! itself — the tool, its JSON schema, the JSON-RPC server, and the localhost
//! bridge are all internal. A consumer never implements an MCP tool. Its entire
//! interactive surface is the event protocol:
//!
//! - receive [`KataEvent::AskRequested`] and render the questions in your UI;
//! - reply with an [`Answer`] via the [`answer_channel`] sender — or, out of
//!   process, by writing an `answer <id> <json>` line to the engine's stdin.
//!
//! The MCP server is spawned as `<current exe> mcp-ask`, so **interactive runs
//! must be driven by the `kata` binary** (spawn `kata run` and stream its
//! events). Linking [`run()`] into a *different* host binary works for
//! non-interactive runs and every pure operation here; interactive in that mode
//! would require the host to serve the `mcp-ask` server itself, which is rarely
//! worth it — spawn `kata` instead.

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

// ---- the interactive ask MCP tool: owned by the engine, not consumer API ----
// `ask::serve_stdio` exists only so the `kata` binary can back its hidden
// `mcp-ask` subcommand; consumers drive interactivity via the event protocol.
#[doc(hidden)]
pub mod ask;

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
