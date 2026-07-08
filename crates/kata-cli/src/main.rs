use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::Ordering;

#[derive(Parser)]
#[command(
    name = "kata",
    version,
    about = "Run a single headless coding-agent kata"
)]
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
    /// Scaffold a starter run-spec wired to the run-spec JSON Schema.
    Init {
        /// Spec name; writes `<name>.toml` (default: `kata.toml`).
        name: Option<String>,
        /// Overwrite an existing target file.
        #[arg(long)]
        force: bool,
        /// Emit a working-tree-relative `#:schema` path instead of the pinned URL.
        #[arg(long)]
        local: bool,
    },
    /// (internal) MCP stdio server backing the interactive `ask_user` tool.
    #[command(hide = true)]
    McpAsk,
}

// Exit codes: 0 = ok, 1 = validation failure, 2 = load/parse or IO error,
// 73 (EX_CANTCREAT) = init refused to overwrite an existing file,
// 70 (EX_SOFTWARE) = subcommand not yet implemented.
fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Validate { spec } => cmd_validate(&spec),
        Cmd::Catalog => cmd_catalog(),
        Cmd::Run { spec } => cmd_run(&spec),
        Cmd::Bundle { spec, out, force } => cmd_bundle(&spec, out.as_deref(), force),
        Cmd::Init { name, force, local } => cmd_init(name.as_deref(), force, local),
        Cmd::McpAsk => match kata_core::ask::serve_stdio() {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::from(2)
            }
        },
    }
}

fn cmd_validate(path: &std::path::Path) -> ExitCode {
    let spec = match kata_core::spec::load(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(2);
        }
    };
    match kata_core::spec::validate(&spec) {
        Ok(()) => {
            println!("ok: {} valid", path.display());
            ExitCode::SUCCESS
        }
        Err(errs) => {
            for e in errs {
                eprintln!("error: {e}");
            }
            ExitCode::from(1)
        }
    }
}

fn cmd_catalog() -> ExitCode {
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&cwd);
    let entries = kata_core::catalog::discover(&roots);
    match serde_json::to_string_pretty(&entries) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(70)
        }
    }
}

fn cmd_bundle(spec_path: &std::path::Path, out: Option<&std::path::Path>, force: bool) -> ExitCode {
    let spec = match kata_core::spec::load(spec_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(2);
        }
    };
    if let Err(errs) = kata_core::spec::validate(&spec) {
        for e in errs {
            eprintln!("error: {e}");
        }
        return ExitCode::from(1);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let roots = kata_core::catalog::DiscoveryRoots::defaults(&cwd);
    let catalog = kata_core::catalog::discover(&roots);

    let out_dir = out
        .map(PathBuf::from)
        .unwrap_or_else(|| kata_core::bundle::default_out_dir(&spec));

    match kata_core::bundle::bundle(&spec, &catalog, &out_dir, force) {
        Ok(()) => {
            println!("bundled to {}", out_dir.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}

/// Walk up from `start` for a Cargo.toml that declares `[workspace]`.
fn find_workspace_root(start: &std::path::Path) -> Option<PathBuf> {
    for dir in start.ancestors() {
        let cargo = dir.join("Cargo.toml");
        if cargo.is_file() {
            if let Ok(txt) = std::fs::read_to_string(&cargo) {
                if txt.contains("[workspace]") {
                    return Some(dir.to_path_buf());
                }
            }
        }
    }
    None
}

/// Relative path from directory `from_dir` to file `to_file`; both absolute.
fn relative_path(from_dir: &std::path::Path, to_file: &std::path::Path) -> PathBuf {
    let from: Vec<_> = from_dir.components().collect();
    let to: Vec<_> = to_file.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut result = PathBuf::new();
    for _ in common..from.len() {
        result.push("..");
    }
    for comp in &to[common..] {
        result.push(comp.as_os_str());
    }
    result
}

fn cmd_init(name: Option<&str>, force: bool, local: bool) -> ExitCode {
    let file_name = format!("{}.toml", name.unwrap_or("kata"));
    let target = PathBuf::from(&file_name);

    if target.exists() && !force {
        eprintln!(
            "error: {} already exists (pass --force to overwrite)",
            target.display()
        );
        return ExitCode::from(73);
    }

    // Compute the #:schema directive.
    let directive = if local {
        // Resolve the spec's parent directory to an absolute, existing path.
        let cwd = match std::env::current_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::from(2);
            }
        };
        let abs_target = cwd.join(&target);
        let spec_dir = abs_target.parent().unwrap_or(&cwd);
        let spec_dir = match spec_dir.canonicalize() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::from(2);
            }
        };
        let Some(root) = find_workspace_root(&spec_dir) else {
            eprintln!(
                "error: --local requires authoring inside a kata working tree \
                 (no [workspace] Cargo.toml found); use the default (hosted URL) instead"
            );
            return ExitCode::from(2);
        };
        let schema_abs = root.join("schema").join("kata-runspec.schema.json");
        if !schema_abs.exists() {
            eprintln!(
                "error: --local requires authoring inside a kata working tree \
                 (schema/kata-runspec.schema.json not found under the workspace root at {}); \
                 use the default (hosted URL) instead",
                root.display()
            );
            return ExitCode::from(2);
        }
        let rel = relative_path(&spec_dir, &schema_abs);
        // Forward slashes for portability in the directive.
        format!("#:schema {}", rel.to_string_lossy().replace('\\', "/"))
    } else {
        format!(
            "#:schema https://raw.githubusercontent.com/satish-krishna/kata/v{}/schema/kata-runspec.schema.json",
            env!("CARGO_PKG_VERSION")
        )
    };

    let body = kata_core::spec::starter_toml(&directive);
    if let Err(e) = std::fs::write(&target, body) {
        eprintln!("error: {e}");
        return ExitCode::from(2);
    }
    println!(
        "wrote {}. Edit it, then run `kata validate {}`.",
        target.display(),
        target.display()
    );
    ExitCode::SUCCESS
}

#[derive(Debug)]
enum StdinCmd {
    Cancel,
    Answer(kata_core::run::Answer),
}

/// Parse one engine-stdin control line: `cancel` or `answer <id> <json-matrix>`.
fn parse_stdin_line(line: &str) -> Option<StdinCmd> {
    let line = line.trim();
    if line == "cancel" {
        return Some(StdinCmd::Cancel);
    }
    let rest = line.strip_prefix("answer ")?;
    let (id, json) = rest.split_once(' ')?;
    let answers: Vec<Vec<String>> = serde_json::from_str(json.trim()).ok()?;
    Some(StdinCmd::Answer(kata_core::run::Answer {
        id: id.trim().to_string(),
        answers,
    }))
}

fn cmd_run(path: &std::path::Path) -> ExitCode {
    // A directory carrying the kata-bundle.toml marker is a bundle: load its
    // spec and discover the kit ONLY from its vendored .claude (hermetic).
    let (spec, roots) = if kata_core::bundle::is_bundle(path) {
        let spec = match kata_core::spec::load(&path.join("spec.toml")) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::from(2);
            }
        };
        (spec, kata_core::bundle::bundle_roots(path))
    } else {
        let spec = match kata_core::spec::load(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("error: {e}");
                return ExitCode::from(2);
            }
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
                Some(StdinCmd::Cancel) => {
                    stdin_flag.store(true, Ordering::SeqCst);
                    break;
                }
                Some(StdinCmd::Answer(a)) => {
                    let _ = answer_tx.send(a);
                }
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
            if let Some(p) = &outcome.transcript_path {
                eprintln!("transcript: {p}");
            }
            match u8::try_from(outcome.exit_code) {
                Ok(c) => ExitCode::from(c),
                Err(_) => ExitCode::FAILURE,
            }
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
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
