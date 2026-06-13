use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

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
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Validate { spec } => cmd_validate(&spec),
        Cmd::Catalog => cmd_catalog(),
        Cmd::Run { spec } => cmd_run(&spec),
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

// Implemented in later tasks:
fn cmd_catalog() -> ExitCode { eprintln!("not implemented"); ExitCode::from(70) }
fn cmd_run(_path: &std::path::Path) -> ExitCode { eprintln!("not implemented"); ExitCode::from(70) }
