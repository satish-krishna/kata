//! The saved-kata library: named run-specs persisted under `~/.kata/katas`.
use crate::fsutil;
use crate::spec::{self, validate, RunSpec};
use serde::Serialize;
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

/// One `*.toml` in the library that could not be loaded.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, Serialize)]
pub struct KataLoadFailure {
    /// Full path, so the operator can go and fix the file.
    pub path: String,
    /// Why it failed, verbatim from the loader.
    pub message: String,
}

/// The library listing: the katas that loaded, and the files that did not.
///
/// Both halves are reported on purpose. Dropping the failures would make a
/// broken kata simply vanish from the library — no entry, no error, no way to
/// tell it had ever been saved. A file the operator wrote and can no longer see
/// is worse than one they can see is broken.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, Default, Serialize)]
pub struct KataListing {
    /// Loaded katas, sorted by name.
    pub katas: Vec<RunSpec>,
    /// Files that failed to load, sorted by path. Empty in the healthy case.
    pub failures: Vec<KataLoadFailure>,
}

/// Every saved kata, plus every `*.toml` that would not load. Empty listing
/// when there is no home directory.
pub fn list_katas() -> KataListing {
    let Some(dir) = fsutil::katas_dir() else {
        return KataListing::default();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return KataListing::default();
    };
    let mut listing = KataListing::default();
    for path in entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("toml"))
    {
        match spec::load(&path) {
            Ok(spec) => listing.katas.push(spec),
            Err(e) => listing.failures.push(KataLoadFailure {
                path: path.display().to_string(),
                message: e.to_string(),
            }),
        }
    }
    listing.katas.sort_by(|a, b| a.name.cmp(&b.name));
    listing.failures.sort_by(|a, b| a.path.cmp(&b.path));
    listing
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
        assert_eq!(all.katas.len(), 2);
        assert!(all.failures.is_empty());
        assert_eq!(all.katas[0].name, "release-notes"); // sorted by name
        assert_eq!(all.katas[1].name, "triage-flaky-test");
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

    // A kata that cannot be loaded used to be dropped from the listing, so it
    // simply vanished from the library with no way to tell why — or that it had
    // ever been there. The listing now carries both halves.
    #[test]
    #[serial]
    fn list_reports_malformed_instead_of_dropping_it() {
        let _h = with_home();
        save_kata(&kata("good")).unwrap();
        let dir = crate::fsutil::katas_dir().unwrap();
        std::fs::write(dir.join("broken.toml"), "this = is = not = toml").unwrap();

        let listing = list_katas();
        assert_eq!(listing.katas.len(), 1);
        assert_eq!(listing.katas[0].name, "good");

        assert_eq!(
            listing.failures.len(),
            1,
            "the broken file must be reported"
        );
        let f = &listing.failures[0];
        assert!(
            f.path.ends_with("broken.toml"),
            "failure must name the file: {}",
            f.path
        );
        assert!(
            !f.message.is_empty(),
            "failure must carry a reason the operator can act on"
        );
    }

    #[test]
    #[serial]
    fn list_reports_no_failures_when_every_kata_loads() {
        let _h = with_home();
        save_kata(&kata("good")).unwrap();
        let listing = list_katas();
        assert_eq!(listing.katas.len(), 1);
        assert!(listing.failures.is_empty());
    }

    // Failures are sorted too, so the listing is stable between calls rather
    // than following directory order.
    #[test]
    #[serial]
    fn failures_are_sorted_by_path() {
        let _h = with_home();
        let dir = crate::fsutil::katas_dir().unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["zeta.toml", "alpha.toml"] {
            std::fs::write(dir.join(name), "not = = toml").unwrap();
        }
        let listing = list_katas();
        assert_eq!(listing.failures.len(), 2);
        assert!(listing.failures[0].path.ends_with("alpha.toml"));
        assert!(listing.failures[1].path.ends_with("zeta.toml"));
    }
}
