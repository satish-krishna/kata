use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::Ordering;

#[derive(Parser)]
#[command(name = "kata", version, about = "Run a single headless coding-agent kata")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Validate a run-spec file.
    Validate { spec: PathBuf },
    /// List discovered skills and plugins as JSON.
    Catalog,
    /// Run a kata to completion, streaming JSON-line events.
    Run { spec: PathBuf },
    /// Vendor a spec's skills/plugins into a portable bundle folder.
    Bundle {
        spec: PathBuf,
        /// Output directory (default: ./<spec-name>-bundle).
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// Reuse a non-empty output directory, replacing its vendored `.claude` kit.
        #[arg(long)]
        force: bool,
    },
    /// (internal) MCP stdio server backing the interactive `ask_user` tool.
    #[command(hide = true)]
    McpAsk,
}

// Exit codes: 0 = ok, 1 = validation failure, 2 = load/parse error,
// 70 (EX_SOFTWARE) = subcommand not yet implemented.
fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Validate { spec } => cmd_validate(&spec),
        Cmd::Catalog => cmd_catalog(),
        Cmd::Run { spec } => cmd_run(&spec),
        Cmd::Bundle { spec, out, force } => cmd_bundle(&spec, out.as_deref(), force),
        Cmd::McpAsk => match kata_core::ask::serve_stdio() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => { eprintln!("error: {e}"); ExitCode::from(2) }
        },
    }
}

fn cmd_validate(path: &std::path::Path) -> ExitCode {
    let spec = match kata_core::spec::load(path) {
        Ok(s) => s,
        Err(e) => { eprintln!("error: {e}"); return ExitCode::from(2); }
    };
    match kata_core::spec::validate(&spec) {
        Ok(()) => { println!("ok: {} valid", path.display()); ExitCode::SUCCESS }
        Err(errs) => {
            for e in errs { eprintln!("error: {e}"); }
            ExitCode::from(1)
        }
    }
}

fn cmd_catalog() -> ExitCode {
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&cwd);
    let entries = kata_core::catalog::discover(&roots);
    match serde_json::to_string_pretty(&entries) {
        Ok(json) => { println!("{json}"); ExitCode::SUCCESS }
        Err(e) => { eprintln!("error: {e}"); ExitCode::from(70) }
    }
}

fn cmd_bundle(spec_path: &std::path::Path, out: Option<&std::path::Path>, force: bool) -> ExitCode {
    let spec = match kata_core::spec::load(spec_path) {
        Ok(s) => s,
        Err(e) => { eprintln!("error: {e}"); return ExitCode::from(2); }
    };
    if let Err(errs) = kata_core::spec::validate(&spec) {
        for e in errs { eprintln!("error: {e}"); }
        return ExitCode::from(1);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&cwd);
    let catalog = kata_core::catalog::discover(&roots);

    let out_dir = out
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("{}-bundle", kata_core::fsutil::slug(&spec.name))));

    match kata_core::bundle::bundle(&spec, &catalog, &out_dir, force) {
        Ok(()) => { println!("bundled to {}", out_dir.display()); ExitCode::SUCCESS }
        Err(e) => { eprintln!("error: {e}"); ExitCode::from(2) }
    }
}

#[derive(Debug)]
enum StdinCmd {
    Cancel,
    Answer(kata_core::run::Answer),
}

/// Parse one engine-stdin control line: `cancel` or `answer <id> <json-matrix>`.
fn parse_stdin_line(line: &str) -> Option<StdinCmd> {
    let line = line.trim();
    if line == "cancel" { return Some(StdinCmd::Cancel); }
    let rest = line.strip_prefix("answer ")?;
    let (id, json) = rest.split_once(' ')?;
    let answers: Vec<Vec<String>> = serde_json::from_str(json.trim()).ok()?;
    Some(StdinCmd::Answer(kata_core::run::Answer { id: id.trim().to_string(), answers }))
}

fn cmd_run(path: &std::path::Path) -> ExitCode {
    // A directory carrying the kata-bundle.toml marker is a bundle: load its
    // spec and discover the kit ONLY from its vendored .claude (hermetic).
    let (spec, roots) = if kata_core::bundle::is_bundle(path) {
        let spec = match kata_core::spec::load(&path.join("spec.toml")) {
            Ok(s) => s,
            Err(e) => { eprintln!("error: {e}"); return ExitCode::from(2); }
        };
        (spec, kata_core::bundle::bundle_roots(path))
    } else {
        let spec = match kata_core::spec::load(path) {
            Ok(s) => s,
            Err(e) => { eprintln!("error: {e}"); return ExitCode::from(2); }
        };
        let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
        (spec, kata_core::catalog::DiscoveryRoots::defaults(&cwd))
    };
    let catalog = kata_core::catalog::discover(&roots);

    let cancel = kata_core::run::CancelToken::new();
    let flag = cancel.flag();
    // Best-effort Ctrl-C -> cancel. Ignore error if a handler is already set.
    let _ = ctrlc::set_handler(move || flag.store(true, Ordering::SeqCst));

    // GUI / programmatic cancel: a `cancel` line on stdin flips the same flag the
    // ctrlc handler uses. `answer <id> <json>` lines are forwarded to the run
    // loop's answer inbox. EOF (plain CLI use closes stdin) is a no-op.
    let (answer_tx, answers) = kata_core::run::answer_channel();
    let stdin_flag = cancel.flag();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let stdin = std::io::stdin();
        let mut line = String::new();
        while stdin.lock().read_line(&mut line).unwrap_or(0) != 0 {
            match parse_stdin_line(&line) {
                Some(StdinCmd::Cancel) => { stdin_flag.store(true, Ordering::SeqCst); break; }
                Some(StdinCmd::Answer(a)) => { let _ = answer_tx.send(a); }
                None => {}
            }
            line.clear();
        }
    });

    let emit = |event: kata_core::event::KataEvent| {
        // One JSON object per line on stdout.
        if let Ok(line) = serde_json::to_string(&event) {
            println!("{line}");
        }
    };

    match kata_core::run::run(&spec, &catalog, &cancel, &answers, emit) {
        Ok(outcome) => {
            match u8::try_from(outcome.exit_code) {
                Ok(c) => ExitCode::from(c),
                Err(_) => ExitCode::FAILURE,
            }
        }
        Err(e) => { eprintln!("error: {e}"); ExitCode::from(2) }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_stdin_line, StdinCmd};

    #[test]
    fn parses_cancel_and_answer_lines() {
        assert!(matches!(parse_stdin_line("cancel"), Some(StdinCmd::Cancel)));
        match parse_stdin_line(r#"answer q1 [["JWT"]]"#) {
            Some(StdinCmd::Answer(a)) => {
                assert_eq!(a.id, "q1");
                assert_eq!(a.answers, vec![vec!["JWT".to_string()]]);
            }
            other => panic!("expected Answer, got {other:?}"),
        }
        assert!(parse_stdin_line("garbage").is_none());
    }

}
