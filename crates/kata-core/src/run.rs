use crate::assemble::{assemble, AssembleError};
use crate::catalog::CatalogEntry;
use crate::command::{build_invocation, ClaudeInvocation};
use crate::event::KataEvent;
use crate::spec::{validate, Isolation, RunSpec};
use std::io::{BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct RunOutcome {
    pub exit_code: i32,
    /// Absolute path of the per-run transcript, or `None` if it could not be written.
    pub transcript_path: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("invalid spec: {0:?}")]
    Invalid(Vec<String>),
    #[error("assembling kit: {0}")]
    Assemble(#[from] AssembleError),
    #[error("spawning claude: {0}")]
    Spawn(String),
    #[error("worktree isolation: {0}")]
    Worktree(String),
    #[error("auth: {0}")]
    Auth(String),
}

/// Cooperative cancellation shared with the run loop.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    /// Share the underlying flag (e.g. with a Ctrl-C handler).
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.0.clone()
    }
}

const POLL: Duration = Duration::from_millis(100);

/// An operator's answer to a pending `ask.requested`, routed from the engine's
/// stdin (kata-cli) into the run loop.
#[derive(Debug, Clone)]
pub struct Answer {
    pub id: String,
    pub answers: Vec<Vec<String>>,
}

/// The run loop's answer inbox. `Default` is an empty inbox (non-interactive
/// runs never deliver answers). Build a live one with [`answer_channel`].
#[derive(Default)]
pub struct AnswerRx(Option<mpsc::Receiver<Answer>>);

impl AnswerRx {
    fn try_recv(&self) -> Option<Answer> {
        self.0.as_ref().and_then(|rx| rx.try_recv().ok())
    }
}

/// Create a connected (sender, inbox) pair for an interactive run.
pub fn answer_channel() -> (mpsc::Sender<Answer>, AnswerRx) {
    let (tx, rx) = mpsc::channel();
    (tx, AnswerRx(Some(rx)))
}

/// Retasking note appended to claude's system prompt for interactive runs. It is
/// additive (applied even under identity Replace mode) because it describes a
/// Kata-provided capability the operator did not author. See the interactive
/// sessions design spec.
const INTERACTIVE_RETASK: &str = "You have an `ask_user` tool. When you hit a consequential fork you cannot resolve from the task and context — ambiguous requirements, a decision with real trade-offs, a destructive action you are unsure about — call `ask_user` with a crisp question (choose the `kind` that fits: confirm / select / text) instead of guessing. Do not use it for trivia you can decide yourself. Do NOT use any built-in question or prompt tool such as `AskUserQuestion`; only `ask_user` reaches the operator.\n\nCRITICAL: there is no human reading your messages turn by turn. A question you write as plain text does NOT reach the operator — it simply ends the run with the question unanswered. `ask_user` is the ONLY channel that reaches them. So whenever a skill or instruction tells you to \"ask the user\", \"ask one question at a time\", \"present options\", \"get approval\", or \"wait for approval\" before continuing, you MUST carry that out by calling `ask_user` — never by emitting the question as prose and stopping. If a skill expects a back-and-forth dialogue, conduct every turn of that dialogue through `ask_user`.";

/// Append the interactive retask note to the invocation's system prompt without
/// colliding with an identity-mode append.
///
/// claude rejects mixing `--append-system-prompt` (inline) with
/// `--append-system-prompt-file`, and an Append-mode identity has already passed
/// the file form (see `command::build_invocation`). So the retask always uses the
/// file form too: when an identity file already exists, fold the note into it (no
/// new flag); otherwise write a fresh note under `scratch` and pass it. Both
/// `system_prompt_file` and `scratch` must outlive the spawned child.
fn append_interactive_retask(
    inv: &mut ClaudeInvocation,
    system_prompt_file: Option<&str>,
    retask: &str,
    scratch: &std::path::Path,
) -> std::io::Result<()> {
    match system_prompt_file {
        Some(existing) => {
            // command.rs already passed `--append-system-prompt-file <existing>`;
            // append to that file rather than adding a colliding second flag.
            let mut f = std::fs::OpenOptions::new().append(true).open(existing)?;
            write!(f, "\n\n{retask}")?;
        }
        None => {
            let note = scratch.join("retask.txt");
            std::fs::write(&note, retask)?;
            inv.args.push("--append-system-prompt-file".into());
            inv.args.push(note.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

/// Per-run transcript writer: each `KataEvent` is one JSON line, flushed
/// immediately so a run killed by the leash, a cancel, or a panic still leaves a
/// complete-up-to-the-cut record.
struct Transcript {
    out: std::io::BufWriter<std::fs::File>,
}

impl Transcript {
    fn write(&mut self, event: &KataEvent) {
        if let Ok(line) = serde_json::to_string(event) {
            let _ = writeln!(self.out, "{line}");
            let _ = self.out.flush();
        }
    }
}

/// Best-effort: open `<kata-home>/runs/<slug>-<utc>.jsonl`. `Err` (no home,
/// unwritable) means the caller logs a warning and runs without a transcript.
fn open_transcript(spec_name: &str) -> Result<(Transcript, std::path::PathBuf), String> {
    let dir =
        crate::fsutil::runs_dir().ok_or_else(|| "no home directory for ~/.kata".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!(
        "{}-{}.jsonl",
        crate::fsutil::slug(spec_name),
        crate::fsutil::utc_stamp(now)
    );
    let path = dir.join(name);
    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    Ok((
        Transcript {
            out: std::io::BufWriter::new(file),
        },
        path,
    ))
}

pub fn run<F: FnMut(KataEvent)>(
    spec: &RunSpec,
    catalog: &[CatalogEntry],
    cancel: &CancelToken,
    answers: &AnswerRx,
    mut emit: F,
) -> Result<RunOutcome, RunError> {
    validate(spec).map_err(RunError::Invalid)?;
    let assembled = assemble(spec, catalog)?;
    let mut inv = build_invocation(spec, &assembled);

    // Tee the event stream to a per-run transcript. Best-effort: a missing
    // transcript must never fail a real run. Set up before the auth fail-fast so a
    // refused run still leaves a record of why.
    let (mut transcript, transcript_path) = match open_transcript(&spec.name) {
        Ok((t, p)) => (Some(t), Some(p)),
        Err(e) => {
            emit(KataEvent::Log {
                level: "warn".into(),
                message: format!("transcript unavailable: {e}"),
            });
            (None, None)
        }
    };
    // `forward` names the original sink so the tee below reads unambiguously as
    // "write to the transcript, then forward to the original emitter". (Rust `let`
    // is non-recursive, so a closure that shadows `emit` and calls `emit` would
    // resolve to the *previous* binding, not itself — but the rename removes the
    // footgun appearance entirely.)
    let mut forward = emit;
    let mut emit = |event: KataEvent| {
        if let Some(t) = transcript.as_mut() {
            t.write(&event);
        }
        forward(event);
    };

    // Fail fast: a bare run that references a token var it cannot resolve would
    // reach the API unauthenticated. Refuse before creating a worktree or spawning.
    if spec.auth.bare {
        if let Some(name) = spec
            .auth
            .token_env
            .as_ref()
            .filter(|n| !n.trim().is_empty())
        {
            let resolved = std::env::var(name).ok().filter(|v| !v.trim().is_empty());
            if resolved.is_none() {
                let message = format!(
                    "auth.token_env names '{name}', but it is unset or empty in the environment"
                );
                emit(KataEvent::RunError {
                    message: message.clone(),
                    exit_code: 2,
                });
                return Err(RunError::Auth(message));
            }
        }
    }

    // Interactive: bind the ask bridge, hand the child its port + the ask_user
    // MCP tool + the retasking note. The temp dir holds the generated mcp-config
    // and, when there is no identity append file to fold into, the retask note
    // file (see `append_interactive_retask`); it lives until after the child exits.
    let mut interactive_tmp: Option<tempfile::TempDir> = None;
    let mut ask_rx: Option<mpsc::Receiver<crate::ask::AskRequest>> = None;
    if spec.interactive.enabled {
        let bridge = crate::ask::Bridge::bind().map_err(|e| RunError::Spawn(e.to_string()))?;
        let port = bridge.port();
        let (atx, arx) = mpsc::channel();
        bridge.serve(atx, cancel.clone());
        ask_rx = Some(arx);

        let dir = tempfile::tempdir().map_err(|e| RunError::Spawn(e.to_string()))?;
        let exe = std::env::current_exe().map_err(|e| RunError::Spawn(e.to_string()))?;
        let cfg = dir.path().join("mcp-config.json");
        let cfg_body = serde_json::json!({
            "mcpServers": { "kata-ask": {
                "command": exe.to_string_lossy(),
                "args": ["mcp-ask"],
                // Pass the port via the per-server env block too: relying on
                // claude to propagate KATA_ASK_PORT from the child env to this
                // grandchild is not guaranteed. Belt and suspenders.
                "env": { "KATA_ASK_PORT": port.to_string() }
            }}
        })
        .to_string();
        std::fs::write(&cfg, cfg_body).map_err(|e| RunError::Spawn(e.to_string()))?;

        inv.args.push("--mcp-config".into());
        inv.args.push(cfg.to_string_lossy().into_owned());
        append_interactive_retask(
            &mut inv,
            assembled.system_prompt_file.as_deref(),
            INTERACTIVE_RETASK,
            dir.path(),
        )
        .map_err(|e| RunError::Spawn(e.to_string()))?;
        inv.env.push(("KATA_ASK_PORT".into(), port.to_string()));
        interactive_tmp = Some(dir);
    }

    let isolation = match spec.leash.isolation {
        Isolation::None => "none",
        Isolation::Worktree => "worktree",
    };

    // Worktree isolation: branch off HEAD into ~/.kata/worktrees and run there.
    // Refuse (before spawning claude) if workdir is not a git repo.
    let mut cwd = inv.cwd.clone();
    let mut worktree: Option<crate::worktree::Worktree> = None;
    if spec.leash.isolation == Isolation::Worktree {
        match crate::worktree::create(&spec.workdir, &spec.name) {
            Ok(wt) => {
                cwd = wt.path.clone();
                worktree = Some(wt);
            }
            Err(e) => {
                let message = format!("worktree isolation failed for {}: {e}", spec.workdir);
                emit(KataEvent::RunError {
                    message: message.clone(),
                    exit_code: 2,
                });
                return Err(RunError::Worktree(message));
            }
        }
    }

    let (wt_path, wt_branch) = match &worktree {
        Some(wt) => (Some(wt.path.clone()), Some(wt.branch.clone())),
        None => (None, None),
    };
    emit(KataEvent::RunStarted {
        spec: spec.name.clone(),
        model: spec.model.id.clone(),
        workdir: spec.workdir.clone(),
        isolation: isolation.to_string(),
        worktree: wt_path,
        branch: wt_branch,
    });
    emit(KataEvent::Log {
        level: "info".into(),
        message: format!(
            "assembled kit: {} skill(s), {} plugin(s)",
            spec.skills.len(),
            spec.plugins.len()
        ),
    });
    if let Some(p) = &transcript_path {
        emit(KataEvent::Log {
            level: "info".into(),
            message: format!("transcript: {}", p.display()),
        });
    }

    let start = Instant::now();
    let mut cmd = Command::new(&inv.program);
    // claude runs headless (`-p`): it never reads stdin, so give it a closed one.
    // Inheriting the parent's stdin lets an unauthenticated claude block forever on
    // an interactive login prompt instead of fast-failing. (Cancellation uses the
    // *engine's* stdin, handled in kata-cli — not the child's.)
    cmd.args(&inv.args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The child inherits the parent process environment by default.
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    // Reader threads -> one channel of tagged lines. claude reports results on
    // stdout (stream-json) but human-readable errors and prompts (e.g. "Not logged
    // in") go to stderr; we drain stderr on its own thread so a chatty child can't
    // deadlock on a full pipe, and surface each line as a warn-level log event.
    let (tx, rx) = mpsc::channel::<ChildLine>();
    let tx_err = tx.clone();
    let reader_handle = thread::spawn(move || {
        use std::io::BufRead;
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(ChildLine::Out(l)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let stderr_handle = thread::spawn(move || {
        use std::io::BufRead;
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx_err.send(ChildLine::Err(l)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Main loop: pull lines, enforce leash + cancel.
    // The wall-clock cap is never optional: an unset timeout falls back to a
    // default so a hung run is always reaped instead of running forever.
    let timeout_secs = spec.leash.effective_timeout_secs();
    if spec.leash.timeout_secs.is_none() {
        emit(KataEvent::Log {
            level: "info".into(),
            message: format!("no timeout set; applying default wall-clock cap of {timeout_secs}s"),
        });
    }
    let deadline = start + Duration::from_secs(timeout_secs);
    let mut turns: u32 = 0;
    let mut result = None;
    let mut termination: Option<Termination> = None;

    // Interactive await state. The work-clock excludes time spent awaiting an
    // answer: `paused` accumulates that time and shifts the deadline.
    let answer_deadline = spec
        .interactive
        .answer_timeout_secs
        .map(Duration::from_secs);
    let mut awaiting_since: Option<Instant> = None;
    let mut paused: Duration = Duration::ZERO;
    let mut pending: Option<(String, mpsc::Sender<Vec<Vec<String>>>)> = None;
    let mut ask_seq: u32 = 0;

    loop {
        if cancel.is_cancelled() {
            termination = Some(Termination::Cancelled);
            break;
        }
        // Work-clock deadline excludes time spent awaiting an answer.
        if awaiting_since.is_none() && Instant::now() >= deadline + paused {
            termination = Some(Termination::TimedOut);
            break;
        }
        // Answer-deadline: only while awaiting, only if configured.
        if let (Some(since), Some(limit)) = (awaiting_since, answer_deadline) {
            if since.elapsed() >= limit {
                termination = Some(Termination::AnswerTimeout);
                break;
            }
        }
        // A new question from the bridge → emit ask.requested, enter awaiting.
        if pending.is_none() {
            if let Some(arx) = &ask_rx {
                if let Ok(req) = arx.try_recv() {
                    ask_seq += 1;
                    let id = format!("q{ask_seq}");
                    pending = Some((id.clone(), req.reply));
                    awaiting_since = Some(Instant::now());
                    emit(KataEvent::AskRequested {
                        id,
                        questions: req.questions,
                    });
                }
            }
        }
        // An answer from the operator → return it down the bridge, resume.
        if let Some((pid, _)) = &pending {
            if let Some(ans) = answers.try_recv() {
                if &ans.id == pid {
                    let (id, reply) = pending.take().unwrap();
                    let _ = reply.send(ans.answers.clone());
                    if let Some(since) = awaiting_since.take() {
                        paused += since.elapsed();
                    }
                    emit(KataEvent::AskAnswered {
                        id,
                        answers: ans.answers,
                    });
                }
            }
        }
        match rx.recv_timeout(POLL) {
            Ok(ChildLine::Out(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let parsed = crate::event::parse_stream_line(&line);
                if parsed.is_assistant_message {
                    // Engine-side leash: claude 2.1.x has no --max-turns flag, so the
                    // turn cap is enforced here. `None` means unlimited (bounded only
                    // by the wall-clock timeout); when a cap is set, stop once a turn
                    // beyond it begins and kill the child.
                    if let Some(cap) = spec.leash.max_turns {
                        if turns >= cap {
                            termination = Some(Termination::MaxTurns(cap));
                            break;
                        }
                    }
                    turns += 1;
                    emit(KataEvent::Turn { n: turns });
                }
                for e in parsed.events {
                    emit(e);
                }
                if let Some(r) = parsed.result {
                    result = Some(r);
                }
            }
            Ok(ChildLine::Err(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                emit(KataEvent::Log {
                    level: "warn".into(),
                    message: line,
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Both reader threads ended (stdio EOF). Usually the child has
                // exited or is about to — break and let child.wait() collect it.
                // But a child that closes its stdio early yet keeps running must
                // stay leashed: if it has not exited, keep looping so the
                // deadline/cancel checks reap it, instead of blocking forever in
                // an unbounded child.wait().
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(POLL),
                    Err(e) => return Err(RunError::Spawn(e.to_string())),
                }
            }
        }
    }

    // Stop the child for any leashed termination, and decide the terminal event.
    let (exit_code, terminal) = match termination {
        Some(term) => {
            let _ = child.kill();
            let _ = child.wait();
            match term {
                Termination::Cancelled => (130, KataEvent::RunCancelled { exit_code: 130 }),
                Termination::TimedOut => (
                    124,
                    KataEvent::RunError {
                        message: format!("timed out after {timeout_secs}s"),
                        exit_code: 124,
                    },
                ),
                Termination::MaxTurns(cap) => (
                    125,
                    KataEvent::RunError {
                        message: format!("reached max turns ({cap})"),
                        exit_code: 125,
                    },
                ),
                Termination::AnswerTimeout => (
                    123,
                    KataEvent::RunError {
                        message: format!(
                            "answer deadline exceeded after {}s",
                            spec.interactive.answer_timeout_secs.unwrap_or(0)
                        ),
                        exit_code: 123,
                    },
                ),
            }
        }
        None => {
            let status = child.wait().map_err(|e| RunError::Spawn(e.to_string()))?;
            let code = status.code().unwrap_or(1);
            let payload = result.unwrap_or(crate::event::ResultPayload {
                num_turns: turns,
                cost_usd: None,
                is_error: code != 0,
                result: None,
                subtype: None,
            });
            // Guard on the spec actually setting a budget: exit 122 is only
            // reachable when leash.max_budget_usd is set, so a result that
            // carries the subtype without a configured ceiling stays a normal
            // completion (defensive against future subtype reuse).
            if payload.is_budget_exhausted() && spec.leash.max_budget_usd.is_some() {
                let ceiling = spec.leash.max_budget_usd.unwrap_or(0.0);
                let spent = payload.cost_usd.unwrap_or(0.0);
                (
                    122,
                    KataEvent::RunError {
                        message: format!("budget ceiling ${ceiling:.2} reached; spent ${spent:.2}"),
                        exit_code: 122,
                    },
                )
            } else {
                (
                    code,
                    KataEvent::RunCompleted {
                        exit_code: code,
                        is_error: payload.is_error,
                        num_turns: payload.num_turns,
                        cost_usd: payload.cost_usd,
                        duration_ms: start.elapsed().as_millis() as u64,
                        result: payload.result,
                    },
                )
            }
        }
    };

    // The child has exited; surface the worktree diff before the terminal event.
    // A diff failure degrades to a warning — it never masks the run outcome.
    if let Some(wt) = &worktree {
        match crate::worktree::diff(wt) {
            Ok(d) => emit(KataEvent::RunDiff {
                worktree: wt.path.clone(),
                branch: wt.branch.clone(),
                files: d.files,
                insertions: d.insertions,
                deletions: d.deletions,
            }),
            Err(e) => emit(KataEvent::Log {
                level: "warn".into(),
                message: format!("worktree diff failed: {e}"),
            }),
        }
    }
    emit(terminal);

    let _ = reader_handle.join();
    let _ = stderr_handle.join();
    // Keep the interactive temp dir (the generated mcp-config) alive until the
    // child has fully exited above; drop it only now.
    drop(interactive_tmp);
    Ok(RunOutcome {
        exit_code,
        transcript_path: transcript_path.map(|p| p.display().to_string()),
    })
}

/// A line drained from the child, tagged by which stream it came from.
enum ChildLine {
    Out(String),
    Err(String),
}

enum Termination {
    Cancelled,
    TimedOut,
    MaxTurns(u32),
    AnswerTimeout,
}

#[cfg(test)]
mod tests {
    use super::{append_interactive_retask, ClaudeInvocation, INTERACTIVE_RETASK};

    fn has_inline_append(inv: &ClaudeInvocation) -> bool {
        inv.args.iter().any(|a| a == "--append-system-prompt")
    }
    fn append_file_count(inv: &ClaudeInvocation) -> usize {
        inv.args
            .iter()
            .filter(|a| *a == "--append-system-prompt-file")
            .count()
    }

    #[test]
    fn retask_note_steers_to_ask_user_and_bans_the_builtin() {
        assert!(INTERACTIVE_RETASK.contains("ask_user"));
        assert!(INTERACTIVE_RETASK.contains("AskUserQuestion"));
    }

    // Regression: a skill like superpowers:brainstorming drives interaction
    // through prose ("ask one question at a time", "wait for approval") and has no
    // knowledge of `ask_user`. In `claude -p` print mode a prose question silently
    // ends the run, so the operator never sees it. The retask must explicitly
    // override that pattern: name the prose trap and redirect the skill verbs
    // ("ask the user", "present options", "wait for approval") through `ask_user`.
    #[test]
    fn retask_overrides_skill_prose_question_patterns() {
        let note = INTERACTIVE_RETASK.to_lowercase();
        assert!(
            note.contains("plain text") || note.contains("plain-text"),
            "retask must name the prose trap explicitly: {INTERACTIVE_RETASK}"
        );
        assert!(
            note.contains("does not reach") || note.contains("will not reach"),
            "retask must say a prose question does not reach the operator: {INTERACTIVE_RETASK}"
        );
        assert!(
            note.contains("end the run") || note.contains("ends the run"),
            "retask must warn a prose question ends the run: {INTERACTIVE_RETASK}"
        );
        // The skill verbs that must be redirected through ask_user.
        assert!(
            note.contains("present options"),
            "retask must redirect the 'present options' pattern: {INTERACTIVE_RETASK}"
        );
        assert!(
            note.contains("approval"),
            "retask must redirect the 'wait for approval' pattern: {INTERACTIVE_RETASK}"
        );
    }

    // The regression: an Append-mode identity already passed
    // `--append-system-prompt-file`. The interactive retask must NOT also emit the
    // inline `--append-system-prompt` (claude rejects mixing the two forms) nor add
    // a second file flag — it folds the note into the existing identity file.
    #[test]
    fn interactive_retask_folds_into_identity_append_file() {
        let td = tempfile::tempdir().unwrap();
        let id_file = td.path().join("system.txt");
        std::fs::write(&id_file, "IDENTITY PROMPT").unwrap();
        let id_path = id_file.to_string_lossy().into_owned();
        let mut inv = ClaudeInvocation {
            program: "claude".into(),
            args: vec!["--append-system-prompt-file".into(), id_path.clone()],
            cwd: "/w".into(),
            env: vec![],
        };

        append_interactive_retask(&mut inv, Some(&id_path), INTERACTIVE_RETASK, td.path()).unwrap();

        assert!(
            !has_inline_append(&inv),
            "must not add inline --append-system-prompt"
        );
        assert_eq!(
            append_file_count(&inv),
            1,
            "must not add a second --append-system-prompt-file"
        );
        let merged = std::fs::read_to_string(&id_file).unwrap();
        assert!(
            merged.starts_with("IDENTITY PROMPT"),
            "identity prompt preserved"
        );
        assert!(
            merged.contains(INTERACTIVE_RETASK),
            "retask folded into the identity file"
        );
    }

    // With no identity prompt there is no existing file: write our own and pass it
    // by the file form (still never the inline form).
    #[test]
    fn interactive_retask_uses_file_form_when_no_identity_prompt() {
        let td = tempfile::tempdir().unwrap();
        let mut inv = ClaudeInvocation {
            program: "claude".into(),
            args: vec![],
            cwd: "/w".into(),
            env: vec![],
        };

        append_interactive_retask(&mut inv, None, INTERACTIVE_RETASK, td.path()).unwrap();

        assert!(!has_inline_append(&inv));
        assert_eq!(append_file_count(&inv), 1);
        let idx = inv
            .args
            .iter()
            .position(|a| a == "--append-system-prompt-file")
            .unwrap();
        let written = std::fs::read_to_string(&inv.args[idx + 1]).unwrap();
        assert_eq!(written, INTERACTIVE_RETASK);
    }
}
