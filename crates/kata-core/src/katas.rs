//! The saved-kata library: named run-specs persisted under `~/.kata/katas`.
use crate::fsutil;
use crate::spec::{self, validate, RunSpec};
use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum KataError {
    #[error("kata not found")]
    NotFound,
    #[error("kata name must contain at least one letter or digit")]
    InvalidName,
    #[error("invalid spec: {0:?}")]
    Invalid(Vec<String>),
    #[error("{0}")]
    Io(String),
}

fn has_slug(name: &str) -> bool {
    name.chars().any(|c| c.is_ascii_alphanumeric())
}

/// Persist a spec to the library as `<slug(name)>.toml` (overwrites a
/// same-named kata). Validates first; refuses a name with no usable slug.
pub fn save_kata(spec: &RunSpec) -> Result<PathBuf, KataError> {
    validate(spec).map_err(KataError::Invalid)?;
    if !has_slug(&spec.name) {
        return Err(KataError::InvalidName);
    }
    let dir =
        fsutil::katas_dir().ok_or_else(|| KataError::Io("no home directory for ~/.kata".into()))?;
    std::fs::create_dir_all(&dir).map_err(|e| KataError::Io(e.to_string()))?;
    let path = dir.join(format!("{}.toml", fsutil::slug(&spec.name)));
    spec::save(&path, spec).map_err(|e| KataError::Io(e.to_string()))?;
    Ok(path)
}

/// All saved katas, sorted by name. Best-effort: a malformed/unreadable
/// `*.toml` is skipped. Empty when there is no home.
pub fn list_katas() -> Vec<RunSpec> {
    let Some(dir) = fsutil::katas_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<RunSpec> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("toml"))
        .filter_map(|p| spec::load(&p).ok())
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Load one kata by name (slugged). `NotFound` if absent.
pub fn load_kata(name: &str) -> Result<RunSpec, KataError> {
    if !has_slug(name) {
        return Err(KataError::InvalidName);
    }
    let dir = fsutil::katas_dir().ok_or(KataError::NotFound)?;
    let path = dir.join(format!("{}.toml", fsutil::slug(name)));
    if !path.exists() {
        return Err(KataError::NotFound);
    }
    spec::load(&path).map_err(|e| KataError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::RunSpec;
    use serial_test::serial;

    fn kata(name: &str) -> RunSpec {
        RunSpec {
            schema: 1,
            name: name.into(),
            task: "do it".into(),
            workdir: "/w".into(),
            ..Default::default()
        }
    }
    fn with_home() -> tempfile::TempDir {
        let h = tempfile::tempdir().unwrap();
        std::env::set_var("KATA_HOME", h.path());
        h
    }

    #[test]
    #[serial]
    fn save_list_load_round_trip() {
        let _h = with_home();
        save_kata(&kata("triage-flaky-test")).unwrap();
        save_kata(&kata("release-notes")).unwrap();
        let all = list_katas();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "release-notes"); // sorted by name
        assert_eq!(all[1].name, "triage-flaky-test");
        let one = load_kata("triage-flaky-test").unwrap();
        assert_eq!(one.task, "do it");
    }

    #[test]
    #[serial]
    fn load_unknown_is_not_found() {
        let _h = with_home();
        assert!(matches!(load_kata("nope"), Err(KataError::NotFound)));
    }

    #[test]
    #[serial]
    fn save_rejects_nameless_and_invalid() {
        let _h = with_home();
        // A name with no alphanumerics has no usable slug.
        assert!(matches!(
            save_kata(&kata("!!!")),
            Err(KataError::InvalidName)
        ));
        // An invalid spec (empty task) is refused.
        let mut bad = kata("ok-name");
        bad.task = "".into();
        assert!(matches!(save_kata(&bad), Err(KataError::Invalid(_))));
    }

    #[test]
    #[serial]
    fn list_skips_malformed() {
        let _h = with_home();
        save_kata(&kata("good")).unwrap();
        let dir = crate::fsutil::katas_dir().unwrap();
        std::fs::write(dir.join("broken.toml"), "this = is = not = toml").unwrap();
        let all = list_katas();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "good");
    }
}
