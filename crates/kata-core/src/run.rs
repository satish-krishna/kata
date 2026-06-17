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
    cmd.args(&inv.args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The child inherits the parent process environment by default.
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;
    let stdout = child.stdout.take().expect("piped stdout");

    // Reader thread -> channel of lines.
    let (tx, rx) = mpsc::channel::<String>();
    let reader_handle = thread::spawn(move || {
        use std::io::BufRead;
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => { if tx.send(l).is_err() { break; } }
                Err(_) => break,
            }
        }
    });

    // Main loop: pull lines, enforce leash + cancel.
    let deadline = spec.leash.timeout_secs.map(|s| start + Duration::from_secs(s));
    let mut turns: u32 = 0;
    let mut result = None;
    let mut termination: Option<Termination> = None;

    loop {
        if cancel.is_cancelled() {
            termination = Some(Termination::Cancelled);
            break;
        }
        if let Some(d) = deadline {
            if Instant::now() >= d {
                termination = Some(Termination::TimedOut);
                break;
            }
        }
        match rx.recv_timeout(POLL) {
            Ok(line) => {
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
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // child closed stdout
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
                    message: format!("timed out after {}s", spec.leash.timeout_secs.unwrap_or(0)),
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
    Ok(RunOutcome { exit_code })
}

enum Termination {
    Cancelled,
    TimedOut,
    MaxTurns,
}
