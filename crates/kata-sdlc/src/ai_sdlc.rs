//! The one door to the ai-sdlc program: `node <plugin>/tools/ai-sdlc.ts <command>`.
use serde_json::Value;
use std::path::PathBuf;

/// Where an ai-sdlc command works: the master repository and the workspace around it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub master: PathBuf,
    pub workspace: PathBuf,
}

/// Why the program gave no answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProgramError {
    #[error("the ai-sdlc program could not run: {message}")]
    CouldNotRun { message: String },
    #[error("the installed ai-sdlc plugin is too old: {found}")]
    TooOld { found: String },
    #[error("the ai-sdlc program refused: {stdout}")]
    Refused { stdout: String },
}

/// The ai-sdlc program: the Node.js executable and the entry file it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Program {
    pub node: PathBuf,
    pub entry: PathBuf,
}

impl Program {
    /// Runs `command` (for example `["resolve", "--json"]`) and returns the JSON on its last stdout line.
    pub fn run(&self, command: &[&str], place: &Place) -> Result<Value, ProgramError> {
        let _ = (command, place);
        unimplemented!("ai_sdlc::Program::run")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use std::path::Path;

    fn program() -> Program {
        Program {
            node: "node".into(),
            entry: Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ai-sdlc-tools/ai-sdlc.ts"),
        }
    }

    /// A workspace holding a master repository with a marker.
    fn workspace() -> (tempfile::TempDir, Place) {
        let dir = tempfile::tempdir().unwrap();
        let master = testutil::repo(dir.path(), "ai-sdlc");
        testutil::commit_file(&master, ".ai-sdlc.json", "{}\n", "marker");
        let place = Place {
            master,
            workspace: dir.path().to_path_buf(),
        };
        (dir, place)
    }

    fn same_path(value: &Value, expected: &Path) -> bool {
        let norm = |s: &str| s.replace('\\', "/").to_lowercase();
        value
            .as_str()
            .is_some_and(|s| norm(s) == norm(&expected.display().to_string()))
    }

    #[test]
    fn run_returns_the_json_of_exit_0_and_1() {
        let (_dir, place) = workspace();
        let found = program().run(&["resolve", "--json"], &place).unwrap();
        assert_eq!(found["problems"], serde_json::json!([]));

        let nowhere = Place {
            master: place.workspace.join("missing"),
            workspace: place.workspace.clone(),
        };
        let refused = program().run(&["resolve", "--json"], &nowhere).unwrap();
        assert!(!refused["problems"].as_array().unwrap().is_empty());
    }

    #[test]
    fn exit_2_is_could_not_run_with_stderr() {
        let (_dir, place) = workspace();
        match program().run(&["resolve"], &place) {
            Err(ProgramError::CouldNotRun { message }) => assert!(!message.is_empty()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn master_and_workspace_are_passed() {
        let (_dir, place) = workspace();
        let found = program().run(&["resolve", "--json"], &place).unwrap();
        assert!(same_path(&found["master"], &place.master), "{found}");
        assert!(same_path(&found["workspace"], &place.workspace), "{found}");
    }
}
