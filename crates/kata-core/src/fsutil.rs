use std::path::{Path, PathBuf};

/// Format seconds-since-the-Unix-epoch (UTC) as a compact stamp `YYYYMMDDThhmmssZ`.
/// Pure function of the input — no system clock — so it is deterministically testable.
pub fn utc_stamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let sod = unix_secs % 86_400;
    let (h, m, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}{mo:02}{d:02}T{h:02}{m:02}{s:02}Z")
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
}
