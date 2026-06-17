use crate::assemble::{assemble, AssembleError};
use crate::catalog::CatalogEntry;
use crate::command::build_invocation;
use crate::event::KataEvent;
use crate::spec::{validate, Isolation, RunSpec};
use std::io::BufReader;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct RunOutcome {
    pub exit_code: i32,
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
    pub fn new() -> Self { Self(Arc::new(AtomicBool::new(false))) }
    pub fn cancel(&self) { self.0.store(true, Ordering::SeqCst); }
    pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::SeqCst) }
    /// Share the underlying flag (e.g. with a Ctrl-C handler).
    pub fn flag(&self) -> Arc<AtomicBool> { self.0.clone() }
}

const POLL: Duration = Duration::from_millis(100);

pub fn run<F: FnMut(KataEvent)>(
    spec: &RunSpec,
    catalog: &[CatalogEntry],
    cancel: &CancelToken,
    mut emit: F,
) -> Result<RunOutcome, RunError> {
    validate(spec).map_err(RunError::Invalid)?;
    let assembled = assemble(spec, catalog)?;
    let inv = build_invocation(spec, &assembled);

    // Fail fast: a bare run that references a token var it cannot resolve would
    // reach the API unauthenticated. Refuse before creating a worktree or spawning.
    if spec.auth.bare {
        if let Some(name) = spec.auth.token_env.as_ref().filter(|n| !n.trim().is_empty()) {
            let resolved = std::env::var(name).ok().filter(|v| !v.trim().is_empty());
            if resolved.is_none() {
                let message = format!(
                    "auth.token_env names '{name}', but it is unset or empty in the environment"
                );
                emit(KataEvent::RunError { message: message.clone() });
                return Err(RunError::Auth(message));
            }
        }
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
                emit(KataEvent::RunError { message: message.clone() });
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
        message: format!("assembled kit: {} skill(s), {} plugin(s)", spec.skills.len(), spec.plugins.len()),
    });

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
                Ok(l) => { if tx.send(ChildLine::Out(l)).is_err() { break; } }
                Err(_) => break,
            }
        }
    });
    let stderr_handle = thread::spawn(move || {
        use std::io::BufRead;
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => { if tx_err.send(ChildLine::Err(l)).is_err() { break; } }
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

    loop {
        if cancel.is_cancelled() {
            termination = Some(Termination::Cancelled);
            break;
        }
        if Instant::now() >= deadline {
            termination = Some(Termination::TimedOut);
            break;
        }
        match rx.recv_timeout(POLL) {
            Ok(ChildLine::Out(line)) => {
                if line.trim().is_empty() { continue; }
                let parsed = crate::event::parse_stream_line(&line);
                if parsed.is_assistant_message {
                    // Engine-side leash: claude 2.1.x has no --max-turns flag, so the
                    // turn cap is enforced here. Allow up to max_turns turns; if a turn
                    // beyond the cap begins, stop and kill the child.
                    if turns >= spec.leash.max_turns {
                        termination = Some(Termination::MaxTurns);
                        break;
                    }
                    turns += 1;
                    emit(KataEvent::Turn { n: turns });
                }
                for e in parsed.events { emit(e); }
                if let Some(r) = parsed.result { result = Some(r); }
            }
            Ok(ChildLine::Err(line)) => {
                if line.trim().is_empty() { continue; }
                emit(KataEvent::Log { level: "warn".into(), message: line });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // child closed both streams
        }
    }

    // Stop the child for any leashed termination, and decide the terminal event.
    let (exit_code, terminal) = match termination {
        Some(term) => {
            let _ = child.kill();
            let _ = child.wait();
            match term {
                Termination::Cancelled => (130, KataEvent::RunCancelled),
                Termination::TimedOut => (124, KataEvent::RunError {
                    message: format!("timed out after {timeout_secs}s"),
                }),
                Termination::MaxTurns => (125, KataEvent::RunError {
                    message: format!("reached max turns ({})", spec.leash.max_turns),
                }),
            }
        }
        None => {
            let status = child.wait().map_err(|e| RunError::Spawn(e.to_string()))?;
            let code = status.code().unwrap_or(1);
            let payload = result.unwrap_or(crate::event::ResultPayload {
                num_turns: turns, cost_usd: None, is_error: code != 0, result: None,
            });
            (code, KataEvent::RunCompleted {
                exit_code: code,
                is_error: payload.is_error,
                num_turns: payload.num_turns,
                cost_usd: payload.cost_usd,
                duration_ms: start.elapsed().as_millis() as u64,
                result: payload.result,
            })
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
    Ok(RunOutcome { exit_code })
}

/// A line drained from the child, tagged by which stream it came from.
enum ChildLine {
    Out(String),
    Err(String),
}

enum Termination {
    Cancelled,
    TimedOut,
    MaxTurns,
}
