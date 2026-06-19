use std::path::{Path, PathBuf};

/// Resolve Kata's home directory: `KATA_HOME` if set and non-empty (taken
/// verbatim), else `<HOME or USERPROFILE>/.kata`. `None` when no home variable is
/// set — callers decide whether that is fatal (worktrees) or best-effort (transcripts).
pub fn kata_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("KATA_HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    let base = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(base).join(".kata"))
}

/// `<kata-home>/runs`, where per-run transcripts are written. `None` when no home.
pub fn runs_dir() -> Option<PathBuf> {
    kata_home().map(|h| h.join("runs"))
}

/// `<kata-home>/katas`, the saved-kata library. `None` when no home.
pub fn katas_dir() -> Option<PathBuf> { kata_home().map(|h| h.join("katas")) }

/// `<kata-home>/presets`, the context-preset library. `None` when no home.
pub fn presets_dir() -> Option<PathBuf> { kata_home().map(|h| h.join("presets")) }

/// Format seconds-since-the-Unix-epoch (UTC) as a compact stamp `YYYYMMDDThhmmssZ`.
/// Pure function of the input — no system clock — so it is deterministically testable.
pub fn utc_stamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let sod = unix_secs % 86_400;
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}{mo:02}{d:02}T{h:02}{m:02}{s:02}Z")
}

/// Inverse of [`utc_stamp`]: parse the trailing `YYYYMMDDThhmmssZ` of a filename
/// stem into seconds since the Unix epoch. `None` when the stem has no valid stamp.
pub fn parse_stamp(stem: &str) -> Option<u64> {
    let start = stem.len().checked_sub(16)?;
    let s = stem.get(start..)?;
    let b = s.as_bytes();
    if b.len() != 16 || b[8] != b'T' || b[15] != b'Z' { return None; }
    let n = |range: std::ops::Range<usize>| s.get(range).and_then(|x| x.parse::<i64>().ok());
    let (y, mo, d) = (n(0..4)?, n(4..6)? as u32, n(6..8)? as u32);
    let (h, mi, se) = (n(9..11)?, n(11..13)?, n(13..15)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) { return None; }
    if h >= 24 || mi >= 60 || se >= 60 { return None; }
    let days = days_from_civil(y, mo, d);
    u64::try_from(days * 86_400 + h * 3600 + mi * 60 + se).ok()
}

/// Howard Hinnant's `days_from_civil`: (year, month, day) → days since 1970-01-01.
/// Inverse of [`civil_from_days`]. Public-domain algorithm.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Howard Hinnant's `civil_from_days`: convert days since 1970-01-01 to
/// (year, month, day). Public-domain algorithm, valid for the full range we care
/// about. See https://howardhinnant.github.io/date_algorithms.html#civil_from_days
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Sanitize a spec name into a single filesystem-safe path segment: map anything
/// outside `[A-Za-z0-9_-]` to '-', trim leading/trailing '-', fall back to "bundle"
/// when nothing remains. Spec names may legally contain path separators, so this is
/// a path-traversal guard, not a cosmetic nicety.
pub fn slug(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = mapped.trim_matches('-');
    if trimmed.is_empty() { "bundle".to_string() } else { trimmed.to_string() }
}

/// Recursively copy a directory tree from `src` into `dst` (created if absent).
///
/// Symlinks are skipped, never followed: a vendoring copy must not traverse a
/// link out of the source tree (a symlink inside an untrusted skill/plugin dir
/// could otherwise pull arbitrary host files into the copy).
pub fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn kata_home_resolution_order() {
        // Save with var_os (env vars can be non-UTF-8; var() would lose them).
        let saved: Vec<(&str, Option<std::ffi::OsString>)> = ["KATA_HOME", "HOME", "USERPROFILE"]
            .iter().map(|k| (*k, std::env::var_os(k))).collect();

        // Gather every result under its controlled env FIRST, then restore, then
        // assert. Restoring before the assertions means a failing assertion can't
        // skip the restore and leak a mutated env into later (serial) tests.
        std::env::set_var("KATA_HOME", "/tmp/khome");
        let r_explicit = super::kata_home(); // KATA_HOME taken verbatim (not joined with .kata)
        let r_runs = super::runs_dir();

        std::env::remove_var("KATA_HOME");
        std::env::remove_var("USERPROFILE");
        std::env::set_var("HOME", "/tmp/h");
        let r_fallback = super::kata_home(); // falls back to <HOME>/.kata

        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");
        std::env::remove_var("KATA_HOME");
        let r_none = super::kata_home(); // nothing set => None

        for (k, v) in &saved {
            match v { Some(val) => std::env::set_var(k, val), None => std::env::remove_var(k) }
        }

        assert_eq!(r_explicit, Some(std::path::PathBuf::from("/tmp/khome")));
        assert_eq!(r_runs, Some(std::path::PathBuf::from("/tmp/khome").join("runs")));
        assert_eq!(r_fallback, Some(std::path::PathBuf::from("/tmp/h").join(".kata")));
        assert_eq!(r_none, None);
    }

    #[test]
    fn copies_nested_tree() {
        let src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("a")).unwrap();
        std::fs::write(src.path().join("a").join("f.txt"), "hi").unwrap();
        let dst = tempfile::tempdir().unwrap();
        let target = dst.path().join("out");
        copy_dir(src.path(), &target).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("a").join("f.txt")).unwrap(), "hi");
    }

    // Symlinks are skipped, not followed: a link inside the source tree must
    // not cause its (out-of-tree) target to be vendored into the copy.
    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let secret = tempfile::tempdir().unwrap();
        std::fs::write(secret.path().join("secret.txt"), "host-only").unwrap();

        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("real.txt"), "ok").unwrap();
        std::os::unix::fs::symlink(secret.path().join("secret.txt"), src.path().join("link.txt")).unwrap();

        let dst = tempfile::tempdir().unwrap();
        let target = dst.path().join("out");
        copy_dir(src.path(), &target).unwrap();

        assert_eq!(std::fs::read_to_string(target.join("real.txt")).unwrap(), "ok");
        assert!(!target.join("link.txt").exists(), "symlink must not be copied or followed");
    }

    #[test]
    fn utc_stamp_formats_known_epochs() {
        assert_eq!(super::utc_stamp(0), "19700101T000000Z");
        // 2001-09-09 01:46:40 UTC — the classic 1e9 instant.
        assert_eq!(super::utc_stamp(1_000_000_000), "20010909T014640Z");
        // 2020-02-29 00:00:00 UTC — exercises the leap day.
        assert_eq!(super::utc_stamp(1_582_934_400), "20200229T000000Z");
    }

    #[test]
    fn parse_stamp_inverts_utc_stamp() {
        for secs in [0u64, 1_000_000_000, 1_718_900_000, 1_766_096_012] {
            let stem = format!("my-kata-{}", utc_stamp(secs));
            assert_eq!(parse_stamp(&stem), Some(secs), "round-trip failed for {secs}");
        }
        assert_eq!(parse_stamp("no-stamp-here"), None);
        assert_eq!(parse_stamp("short"), None);
        // Out-of-range time/date components are rejected, not wrapped into a
        // bogus huge timestamp.
        assert_eq!(parse_stamp("k-20260101T999999Z"), None, "hour/min/sec >= bounds");
        assert_eq!(parse_stamp("k-20260101T250000Z"), None, "hour 25");
        assert_eq!(parse_stamp("k-20261301T000000Z"), None, "month 13");
    }

    #[test]
    fn slug_strips_path_separators_and_falls_back() {
        assert_eq!(super::slug("../x"), "x");
        assert_eq!(super::slug("a/b"), "a-b");
        assert_eq!(super::slug("a\\b"), "a-b");
        assert_eq!(super::slug("triage-flaky_1"), "triage-flaky_1");
        assert_eq!(super::slug("型"), "bundle");
        assert_eq!(super::slug("..."), "bundle");
    }
}
