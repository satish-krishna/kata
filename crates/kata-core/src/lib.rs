//! Kata engine — the reference implementation of the two cross-language
//! contracts: the run-spec ([`RunSpec`]) and the event protocol ([`KataEvent`]).
//!
//! # In-process (Rust)
//!
//! Link the library and drive a run directly, receiving every [`KataEvent`] as a
//! callback. This example is compiled as a doctest, so the guide stays honest:
//!
//! ```no_run
//! use kata_core::{answer_channel, run, Answer, CancelToken, KataEvent};
//!
//! let spec = kata_core::spec::load("triage.toml".as_ref())?;
//! let catalog = kata_core::catalog::discover(
//!     &kata_core::catalog::roots_for_workdir(Some(&spec.workdir)));
//!
//! // Call cancel.cancel() from another thread to stop the run.
//! let cancel = CancelToken::new();
//! // Keep the sender to answer interactive questions; drop it for non-interactive runs.
//! let (answer_tx, answers) = answer_channel();
//!
//! let outcome = run(&spec, &catalog, &cancel, &answers, |event| match event {
//!     // Interactive fork: reply with one Vec<String> per question
//!     // (chosen option labels, [typed text], or [] to skip an optional one).
//!     KataEvent::AskRequested { id, questions } => {
//!         let reply = questions.iter().map(|_| vec![String::from("yes")]).collect();
//!         let _ = answer_tx.send(Answer { id, answers: reply });
//!     }
//!     // Everything else: forward to your UI, a socket, a log...
//!     other => println!("{}", serde_json::to_string(&other).unwrap()),
//! })?;
//!
//! println!("run finished with exit code {}", outcome.exit_code);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! # Out-of-process (any language)
//!
//! Spawn the `kata` binary and read one [`KataEvent`] JSON object per line off
//! its stdout; write `cancel` / `answer <id> <json>` lines to its stdin. Only
//! the run-spec and event shapes are contractual — not this crate's Rust API.
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
pub(crate) mod builtin;
pub(crate) mod command;
pub(crate) mod fsutil;
