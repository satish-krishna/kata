use std::path::Path;

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
}
